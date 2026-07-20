-- Role-gated, idempotent cloud mutations. Every public function derives the actor
-- from auth.uid(); no role, family id, reward amount or ledger row is trusted from the client.

create function public.submit_task(
  p_task_id text,
  p_selected_pushups integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('child');
  v_actor uuid := auth.uid();
  v_today date;
  v_task public.tasks;
  v_state public.daily_task_states;
  v_submitted_xp integer;
  v_pushups integer;
  v_claim record;
  v_revision bigint;
  v_response jsonb;
begin
  v_today := private.ensure_current_day(v_member.family_id);

  select t.* into v_task
  from public.tasks as t
  where t.family_id = v_member.family_id
    and t.client_id = p_task_id
    and t.active;
  if v_task.id is null then
    raise exception using errcode = 'P0002', message = 'mission not found';
  end if;

  if v_task.task_type = 'pushups' then
    v_pushups := coalesce(p_selected_pushups, 10);
    if v_pushups not in (10, 20, 30, 40, 50) then
      raise exception using errcode = '22023', message = 'push-up count must be 10, 20, 30, 40 or 50';
    end if;
    v_submitted_xp := v_pushups / 2;
  else
    if p_selected_pushups is not null then
      raise exception using errcode = '22023', message = 'push-up count is only valid for the push-ups mission';
    end if;
    v_pushups := null;
    v_submitted_xp := v_task.xp;
  end if;

  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'submit_task',
    jsonb_build_object('taskId', p_task_id, 'selectedPushUps', v_pushups),
    v_member.family_id
  );
  if not v_claim.is_new then
    return v_claim.prior_response;
  end if;

  insert into public.daily_task_states (family_id, task_id, local_date)
  values (v_member.family_id, v_task.id, v_today)
  on conflict (family_id, task_id, local_date) do nothing;

  select dts.* into v_state
  from public.daily_task_states as dts
  where dts.family_id = v_member.family_id
    and dts.task_id = v_task.id
    and dts.local_date = v_today
  for update;

  if v_state.status = 'approved' then
    raise exception using errcode = '55000', message = 'mission is already approved';
  end if;
  if v_state.status = 'pending' then
    raise exception using errcode = '55000', message = 'mission is already awaiting review';
  end if;

  update public.daily_task_states
  set status = 'pending',
      pushup_count = v_pushups,
      submitted_xp = v_submitted_xp,
      requested_by = v_member.id,
      requested_at = clock_timestamp(),
      reviewed_by = null,
      reviewed_at = null,
      active_award_id = null,
      updated_at = clock_timestamp()
  where id = v_state.id;

  perform private.log_event(
    v_member.family_id, v_today, 'submitted',
    v_task.title || ' — отправлено на проверку', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'dailyTaskStateId', v_state.id,
    'taskId', v_task.client_id,
    'status', 'pending',
    'submittedXp', v_submitted_xp,
    'selectedPushUps', v_pushups,
    'revision', v_revision
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.review_task(
  p_daily_state_id uuid,
  p_decision text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_claim record;
  v_state public.daily_task_states;
  v_task public.tasks;
  v_settings public.family_settings;
  v_award_id uuid;
  v_approval_revision integer;
  v_minutes integer := 0;
  v_revision bigint;
  v_response jsonb;
  v_decision text := lower(btrim(coalesce(p_decision, '')));
begin
  perform private.ensure_current_day(v_member.family_id);
  if v_decision in ('approve', 'approved') then
    v_decision := 'approve';
  elsif v_decision in ('reject', 'rejected') then
    v_decision := 'reject';
  else
    raise exception using errcode = '22023', message = 'decision must be approved or rejected';
  end if;

  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'review_task',
    jsonb_build_object('dailyTaskStateId', p_daily_state_id, 'decision', v_decision),
    v_member.family_id
  );
  if not v_claim.is_new then
    return v_claim.prior_response;
  end if;

  select dts.* into v_state
  from public.daily_task_states as dts
  where dts.id = p_daily_state_id and dts.family_id = v_member.family_id
  for update;
  if v_state.id is null then
    raise exception using errcode = 'P0002', message = 'submitted mission not found';
  end if;
  if v_state.status <> 'pending' then
    raise exception using errcode = '55000', message = 'mission is not awaiting review';
  end if;

  select t.* into v_task from public.tasks as t where t.id = v_state.task_id;

  if v_decision = 'approve' then
    select fs.* into v_settings
    from public.family_settings as fs where fs.family_id = v_member.family_id;
    v_approval_revision := v_state.approval_revision + 1;
    v_minutes := floor(v_state.submitted_xp * v_settings.xp_to_minutes)::integer;

    insert into public.reward_transactions (
      family_id, local_date, task_id, daily_task_state_id, transaction_type,
      xp_delta, minutes_delta, created_by, approval_revision, operation_key_hash
    ) values (
      v_member.family_id, v_state.local_date, v_state.task_id, v_state.id, 'award',
      v_state.submitted_xp, v_minutes, v_member.id, v_approval_revision,
      private.operation_hash(p_idempotency_key)
    ) returning id into v_award_id;

    update public.daily_task_states
    set status = 'approved',
        reviewed_by = v_member.id,
        reviewed_at = clock_timestamp(),
        approval_revision = v_approval_revision,
        active_award_id = v_award_id,
        updated_at = clock_timestamp()
    where id = v_state.id;

    perform private.log_event(
      v_member.family_id, v_state.local_date, 'approved',
      v_task.title || ' — подтверждено, +' || v_state.submitted_xp || ' XP', v_member.id
    );
  else
    update public.daily_task_states
    set status = 'rejected',
        reviewed_by = v_member.id,
        reviewed_at = clock_timestamp(),
        active_award_id = null,
        updated_at = clock_timestamp()
    where id = v_state.id;

    perform private.log_event(
      v_member.family_id, v_state.local_date, 'rejected',
      v_task.title || ' — отклонено', v_member.id
    );
  end if;

  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_strip_nulls(jsonb_build_object(
    'dailyTaskStateId', v_state.id,
    'taskId', v_task.client_id,
    'status', case when v_decision = 'approve' then 'approved' else 'rejected' end,
    'awardId', v_award_id,
    'reward', case when v_decision = 'approve'
      then jsonb_build_object('xp', v_state.submitted_xp, 'minutes', v_minutes)
      else null end,
    'revision', v_revision
  ));
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.undo_approval(
  p_daily_state_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'Подтверждение отменено родителем'), 240);
  v_claim record;
  v_state public.daily_task_states;
  v_task public.tasks;
  v_award public.reward_transactions;
  v_reversal_id uuid;
  v_revision bigint;
  v_response jsonb;
begin
  perform private.ensure_current_day(v_member.family_id);
  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'undo_approval',
    jsonb_build_object('dailyTaskStateId', p_daily_state_id, 'reason', v_reason),
    v_member.family_id
  );
  if not v_claim.is_new then
    return v_claim.prior_response;
  end if;

  select dts.* into v_state
  from public.daily_task_states as dts
  where dts.id = p_daily_state_id and dts.family_id = v_member.family_id
  for update;
  if v_state.id is null or v_state.status <> 'approved' or v_state.active_award_id is null then
    raise exception using errcode = '55000', message = 'active approval not found';
  end if;

  select rt.* into v_award
  from public.reward_transactions as rt
  where rt.id = v_state.active_award_id
    and rt.family_id = v_member.family_id
    and rt.transaction_type = 'award';
  if v_award.id is null then
    raise exception using errcode = 'P0002', message = 'award transaction not found';
  end if;

  perform private.stop_active_timer_internal(
    v_member.family_id, clock_timestamp(), 'reward reversed', private.operation_hash(p_idempotency_key)
  );

  insert into public.reward_transactions (
    family_id, local_date, task_id, daily_task_state_id, transaction_type,
    xp_delta, minutes_delta, reason, created_by, reverses_transaction_id,
    approval_revision, operation_key_hash
  ) values (
    v_member.family_id, v_state.local_date, v_state.task_id, v_state.id, 'reversal',
    -v_award.xp_delta, -v_award.minutes_delta, v_reason, v_member.id, v_award.id,
    v_award.approval_revision, private.operation_hash(p_idempotency_key)
  ) returning id into v_reversal_id;

  update public.daily_task_states
  set status = 'pending',
      reviewed_by = v_member.id,
      reviewed_at = clock_timestamp(),
      active_award_id = null,
      updated_at = clock_timestamp()
  where id = v_state.id;

  select t.* into v_task from public.tasks as t where t.id = v_state.task_id;
  perform private.log_event(
    v_member.family_id, v_state.local_date, 'reversed',
    v_task.title || ' — подтверждение отменено', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'dailyTaskStateId', v_state.id,
    'taskId', v_task.client_id,
    'status', 'pending',
    'reversalId', v_reversal_id,
    'xpDelta', -v_award.xp_delta,
    'minutesDelta', -v_award.minutes_delta,
    'revision', v_revision
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.reverse_task_approval(
  p_daily_state_id uuid,
  p_reason text,
  p_operation_id text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.undo_approval(p_daily_state_id, p_reason, p_operation_id)
$$;

create function public.add_custom_task(
  p_title text,
  p_xp integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_title text := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
  v_claim record;
  v_task public.tasks;
  v_revision bigint;
  v_response jsonb;
begin
  if char_length(v_title) not between 2 and 80 then
    raise exception using errcode = '22023', message = 'mission title must contain 2 to 80 characters';
  end if;
  if p_xp not between 1 and 500 then
    raise exception using errcode = '22023', message = 'mission XP must be between 1 and 500';
  end if;

  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'add_custom_task',
    jsonb_build_object('title', v_title, 'xp', p_xp), v_member.family_id
  );
  if not v_claim.is_new then
    return v_claim.prior_response;
  end if;

  insert into public.tasks (
    family_id, client_id, title, icon, xp, required, built_in, task_type, sort_order
  ) values (
    v_member.family_id,
    'custom-' || replace(gen_random_uuid()::text, '-', ''),
    v_title, '⭐', p_xp, false, false, 'custom',
    coalesce((select max(t.sort_order) + 10 from public.tasks as t where t.family_id = v_member.family_id), 10)
  ) returning * into v_task;

  perform private.log_event(
    v_member.family_id, private.ensure_current_day(v_member.family_id), 'settings',
    'Добавлена миссия «' || v_title || '»', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'task', jsonb_build_object(
      'id', v_task.client_id, 'title', v_task.title, 'icon', v_task.icon,
      'xp', v_task.xp, 'required', false, 'builtIn', false,
      'kind', 'custom', 'hidden', false, 'createdAt', private.epoch_ms(v_task.created_at)
    ),
    'revision', v_revision
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.update_task(
  p_task_id text,
  p_xp integer,
  p_active boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_claim record;
  v_task public.tasks;
  v_revision bigint;
  v_response jsonb;
begin
  if p_xp is not null and p_xp not between 1 and 500 then
    raise exception using errcode = '22023', message = 'mission XP must be between 1 and 500';
  end if;
  if p_xp is null and p_active is null then
    raise exception using errcode = '22023', message = 'at least one task change is required';
  end if;

  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'update_task',
    jsonb_build_object('taskId', p_task_id, 'xp', p_xp, 'active', p_active),
    v_member.family_id
  );
  if not v_claim.is_new then
    return v_claim.prior_response;
  end if;

  select t.* into v_task
  from public.tasks as t
  where t.family_id = v_member.family_id and t.client_id = p_task_id
  for update;
  if v_task.id is null then
    raise exception using errcode = 'P0002', message = 'mission not found';
  end if;
  if p_active = false and v_task.required then
    raise exception using errcode = '55000', message = 'required mission cannot be hidden';
  end if;
  if p_xp is not null and v_task.task_type = 'pushups' then
    raise exception using errcode = '55000', message = 'push-up reward is derived from repetition count';
  end if;

  update public.tasks
  set xp = coalesce(p_xp, xp),
      active = coalesce(p_active, active),
      updated_at = clock_timestamp()
  where id = v_task.id
  returning * into v_task;

  perform private.log_event(
    v_member.family_id, private.ensure_current_day(v_member.family_id), 'settings',
    v_task.title || ' — настройки изменены', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'taskId', v_task.client_id,
    'xp', v_task.xp,
    'active', v_task.active,
    'revision', v_revision
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.update_family_settings(
  p_xp_to_minutes numeric,
  p_daily_limit_minutes integer,
  p_carry_over_enabled boolean,
  p_theme text,
  p_pin_hash text,
  p_pin_salt text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_claim record;
  v_settings public.family_settings;
  v_revision bigint;
  v_response jsonb;
begin
  if p_xp_to_minutes is not null and p_xp_to_minutes not between 0.25 and 20 then
    raise exception using errcode = '22023', message = 'XP-to-minutes rate must be between 0.25 and 20';
  end if;
  if p_daily_limit_minutes is not null and p_daily_limit_minutes not between 10 and 360 then
    raise exception using errcode = '22023', message = 'daily limit must be between 10 and 360 minutes';
  end if;
  if p_theme is not null and p_theme not in ('system', 'light', 'dark') then
    raise exception using errcode = '22023', message = 'invalid theme';
  end if;
  if (p_pin_hash is null) <> (p_pin_salt is null) then
    raise exception using errcode = '22023', message = 'PIN digest and salt must be changed together';
  end if;
  if p_pin_hash is not null and lower(p_pin_hash) !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'PIN digest must be a SHA-256 hex value';
  end if;
  if p_pin_salt is not null and char_length(p_pin_salt) not between 8 and 200 then
    raise exception using errcode = '22023', message = 'PIN salt must contain 8 to 200 characters';
  end if;

  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'update_family_settings',
    jsonb_build_object(
      'xpToMinutes', p_xp_to_minutes,
      'dailyLimitMinutes', p_daily_limit_minutes,
      'carryOverEnabled', p_carry_over_enabled,
      'theme', p_theme,
      'pinHash', p_pin_hash,
      'pinSalt', p_pin_salt
    ), v_member.family_id
  );
  if not v_claim.is_new then
    return v_claim.prior_response;
  end if;

  update public.family_settings
  set xp_to_minutes = coalesce(p_xp_to_minutes, xp_to_minutes),
      daily_limit_minutes = coalesce(p_daily_limit_minutes, daily_limit_minutes),
      carry_over_enabled = coalesce(p_carry_over_enabled, carry_over_enabled),
      theme = coalesce(p_theme::public.theme_preference, theme),
      updated_at = clock_timestamp()
  where family_id = v_member.family_id
  returning * into v_settings;

  if p_pin_hash is not null then
    update public.parent_secrets
    set pin_hash = lower(p_pin_hash), pin_salt = p_pin_salt,
        has_changed_pin = true, updated_at = clock_timestamp()
    where family_id = v_member.family_id;
  end if;

  perform private.log_event(
    v_member.family_id, private.ensure_current_day(v_member.family_id), 'settings',
    'Настройки наград обновлены', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'settings', jsonb_build_object(
      'xpToMinutes', v_settings.xp_to_minutes,
      'dailyLimitMinutes', v_settings.daily_limit_minutes,
      'carryOver', v_settings.carry_over_enabled,
      'theme', v_settings.theme::text
    ),
    'revision', v_revision
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.change_parent_pin(
  p_pin_hash text,
  p_pin_salt text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_claim record;
  v_revision bigint;
  v_response jsonb;
begin
  if p_pin_hash is null or lower(p_pin_hash) !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'PIN digest must be a SHA-256 hex value';
  end if;
  if p_pin_salt is null or char_length(p_pin_salt) not between 8 and 200 then
    raise exception using errcode = '22023', message = 'PIN salt must contain 8 to 200 characters';
  end if;

  select * into v_claim from private.claim_operation(
    v_actor, p_idempotency_key, 'change_parent_pin',
    jsonb_build_object('pinHash', lower(p_pin_hash), 'pinSalt', p_pin_salt), v_member.family_id
  );
  if not v_claim.is_new then return v_claim.prior_response; end if;

  update public.parent_secrets
  set pin_hash = lower(p_pin_hash), pin_salt = p_pin_salt,
      has_changed_pin = true, updated_at = clock_timestamp()
  where family_id = v_member.family_id;
  perform private.log_event(
    v_member.family_id, private.ensure_current_day(v_member.family_id), 'settings',
    'PIN родителя изменён', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object('changed', true, 'revision', v_revision);
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.adjust_xp(
  p_delta integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_reason text := left(regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g'), 240);
  v_claim record;
  v_total_xp integer;
  v_rate numeric;
  v_minutes integer;
  v_transaction_id uuid;
  v_today date;
  v_revision bigint;
  v_response jsonb;
begin
  if p_delta is null or p_delta = 0 or p_delta not between -10000 and 10000 then
    raise exception using errcode = '22023', message = 'XP adjustment must be a non-zero value from -10000 to 10000';
  end if;
  if char_length(v_reason) < 1 then
    raise exception using errcode = '22023', message = 'adjustment reason is required';
  end if;
  v_today := private.ensure_current_day(v_member.family_id);

  select * into v_claim from private.claim_operation(
    v_actor, p_idempotency_key, 'adjust_xp',
    jsonb_build_object('delta', p_delta, 'reason', v_reason), v_member.family_id
  );
  if not v_claim.is_new then return v_claim.prior_response; end if;

  select coalesce(sum(rt.xp_delta), 0)::integer into v_total_xp
  from public.reward_transactions as rt where rt.family_id = v_member.family_id;
  if v_total_xp + p_delta < 0 then
    raise exception using errcode = '22023', message = 'total XP cannot become negative';
  end if;
  select fs.xp_to_minutes into v_rate
  from public.family_settings as fs where fs.family_id = v_member.family_id;
  v_minutes := case when p_delta > 0 then floor(p_delta * v_rate)::integer
                    else -floor(abs(p_delta) * v_rate)::integer end;

  if p_delta < 0 then
    perform private.stop_active_timer_internal(
      v_member.family_id, clock_timestamp(), 'XP adjusted', private.operation_hash(p_idempotency_key)
    );
  end if;

  insert into public.reward_transactions (
    family_id, local_date, transaction_type, xp_delta, minutes_delta,
    reason, created_by, operation_key_hash
  ) values (
    v_member.family_id, v_today, 'manual', p_delta, v_minutes,
    v_reason, v_member.id, private.operation_hash(p_idempotency_key)
  ) returning id into v_transaction_id;

  perform private.log_event(
    v_member.family_id, v_today, 'manual',
    case when p_delta > 0 then '+' else '' end || p_delta || ' XP — ' || v_reason,
    v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'transactionId', v_transaction_id,
    'xpDelta', p_delta,
    'minutesDelta', v_minutes,
    'totalXp', v_total_xp + p_delta,
    'revision', v_revision
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.reset_today(p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_today date := private.ensure_current_day(v_member.family_id);
  v_claim record;
  v_xp integer;
  v_minutes integer;
  v_reset_id uuid;
  v_revision bigint;
  v_response jsonb;
begin
  select * into v_claim from private.claim_operation(
    v_actor, p_idempotency_key, 'reset_today', '{}'::jsonb, v_member.family_id
  );
  if not v_claim.is_new then return v_claim.prior_response; end if;

  perform private.stop_active_timer_internal(
    v_member.family_id, clock_timestamp(), 'day reset', private.operation_hash(p_idempotency_key)
  );

  select coalesce(sum(rt.xp_delta), 0)::integer,
         coalesce(sum(rt.minutes_delta), 0)::integer
  into v_xp, v_minutes
  from public.reward_transactions as rt
  where rt.family_id = v_member.family_id and rt.local_date = v_today;

  if v_xp <> 0 or v_minutes <> 0 then
    insert into public.reward_transactions (
      family_id, local_date, transaction_type, xp_delta, minutes_delta,
      reason, created_by, operation_key_hash
    ) values (
      v_member.family_id, v_today, 'reset', -v_xp, -v_minutes,
      'Сброс сегодняшнего дня', v_member.id, private.operation_hash(p_idempotency_key)
    ) returning id into v_reset_id;
  end if;

  update public.daily_task_states
  set status = 'todo', pushup_count = null, submitted_xp = null,
      requested_by = null, requested_at = null, reviewed_by = null, reviewed_at = null,
      active_award_id = null, updated_at = clock_timestamp()
  where family_id = v_member.family_id and local_date = v_today;

  update public.daily_family_states
  set used_seconds = 0, updated_at = clock_timestamp()
  where family_id = v_member.family_id and local_date = v_today;

  perform private.log_event(
    v_member.family_id, v_today, 'reset', 'Сегодняшний день сброшен родителем', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_strip_nulls(jsonb_build_object(
    'resetTransactionId', v_reset_id,
    'xpDelta', -v_xp,
    'minutesDelta', -v_minutes,
    'revision', v_revision
  ));
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.start_timer(
  p_duration_seconds integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('child');
  v_actor uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_today date;
  v_claim record;
  v_required integer;
  v_required_done integer;
  v_settings public.family_settings;
  v_day public.daily_family_states;
  v_earned_minutes integer;
  v_budget_seconds integer;
  v_remaining_seconds integer;
  v_ends_at timestamptz;
  v_timer_id uuid;
  v_revision bigint;
  v_response jsonb;
begin
  if p_duration_seconds is null or p_duration_seconds not between 1 and 21600 then
    raise exception using errcode = '22023', message = 'timer duration must be between 1 and 21600 seconds';
  end if;
  v_today := private.ensure_current_day(v_member.family_id, v_now);

  select * into v_claim from private.claim_operation(
    v_actor, p_idempotency_key, 'start_timer',
    jsonb_build_object('durationSeconds', p_duration_seconds), v_member.family_id
  );
  if not v_claim.is_new then return v_claim.prior_response; end if;

  perform 1 from public.timer_sessions as ts
  where ts.family_id = v_member.family_id and ts.status = 'active'
  for update;
  if found then
    raise exception using errcode = '55000', message = 'another timer is already active';
  end if;

  select count(*)::integer,
         count(*) filter (where dts.status = 'approved')::integer
  into v_required, v_required_done
  from public.tasks as t
  left join public.daily_task_states as dts
    on dts.task_id = t.id and dts.local_date = v_today
  where t.family_id = v_member.family_id and t.active and t.required;
  if v_required = 0 or v_required <> v_required_done then
    raise exception using errcode = '55000', message = 'required missions must be approved first';
  end if;

  select fs.* into v_settings from public.family_settings as fs
  where fs.family_id = v_member.family_id;
  select dfs.* into v_day from public.daily_family_states as dfs
  where dfs.family_id = v_member.family_id and dfs.local_date = v_today
  for update;
  select greatest(0, coalesce(sum(rt.minutes_delta), 0))::integer into v_earned_minutes
  from public.reward_transactions as rt
  where rt.family_id = v_member.family_id and rt.local_date = v_today;

  v_budget_seconds := least(
    v_settings.daily_limit_minutes * 60,
    (v_day.carry_in_minutes + v_earned_minutes) * 60
  );
  v_remaining_seconds := greatest(0, v_budget_seconds - v_day.used_seconds);
  if p_duration_seconds > v_remaining_seconds then
    raise exception using errcode = '22023', message = 'not enough available screen time';
  end if;

  v_ends_at := least(
    v_now + make_interval(secs => p_duration_seconds),
    private.next_midnight(v_member.family_id, v_today)
  );
  if v_ends_at <= v_now then
    raise exception using errcode = '22023', message = 'timer cannot start at or after local midnight';
  end if;

  insert into public.timer_sessions (
    family_id, local_date, started_by, started_at, ends_at,
    planned_seconds, start_operation_hash
  ) values (
    v_member.family_id, v_today, v_member.id, v_now, v_ends_at,
    p_duration_seconds, private.operation_hash(p_idempotency_key)
  ) returning id into v_timer_id;

  perform private.log_event(
    v_member.family_id, v_today, 'timer',
    'Запущен таймер на ' || ceil(p_duration_seconds / 60.0)::integer || ' мин', v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'id', v_timer_id,
    'dayKey', v_today::text,
    'startedAt', private.epoch_ms(v_now),
    'endsAt', private.epoch_ms(v_ends_at),
    'durationSeconds', p_duration_seconds,
    'revision', v_revision
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.stop_timer(p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('child');
  v_actor uuid := auth.uid();
  v_claim record;
  v_timer_result jsonb;
  v_revision bigint;
  v_response jsonb;
begin
  perform private.ensure_current_day(v_member.family_id);
  select * into v_claim from private.claim_operation(
    v_actor, p_idempotency_key, 'stop_timer', '{}'::jsonb, v_member.family_id
  );
  if not v_claim.is_new then return v_claim.prior_response; end if;

  v_timer_result := private.stop_active_timer_internal(
    v_member.family_id, clock_timestamp(), 'stopped by child', private.operation_hash(p_idempotency_key)
  );
  if v_timer_result is null then
    raise exception using errcode = '55000', message = 'no active timer';
  end if;
  v_revision := private.bump_revision(v_member.family_id);
  v_response := v_timer_result || jsonb_build_object('revision', v_revision);
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_response);
  return v_response;
end;
$$;

create function public.delete_family(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_family public.families;
  v_response jsonb;
begin
  select f.* into v_family
  from public.families as f
  where f.id = v_member.family_id
  for update;
  if v_family.id is null then
    raise exception using errcode = 'P0002', message = 'family not found';
  end if;
  if p_confirmation is distinct from v_family.name then
    raise exception using
      errcode = '22023',
      message = 'family name confirmation does not match';
  end if;

  -- The transaction-local guard lets the FK cascade remove the ledger while the
  -- append-only trigger continues to reject every standalone row mutation.
  perform pg_catalog.set_config(
    'missions_nikolay.deleting_family', v_family.id::text, true
  );
  delete from public.families where id = v_family.id;
  v_response := jsonb_build_object(
    'deleted', true,
    'familyId', v_family.id,
    'deletedAt', private.epoch_ms(clock_timestamp())
  );
  return v_response;
end;
$$;
