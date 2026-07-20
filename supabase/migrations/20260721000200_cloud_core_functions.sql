-- Internal authorization, idempotency, rollover and snapshot primitives.

create function private.epoch_ms(p_value timestamptz)
returns bigint
language sql
immutable
strict
set search_path = ''
as $$
  select floor(extract(epoch from p_value) * 1000)::bigint
$$;

create function private.operation_hash(p_value text)
returns bytea
language sql
immutable
strict
set search_path = ''
as $$
  select extensions.digest(pg_catalog.convert_to(p_value, 'UTF8'), 'sha256')
$$;

create function private.require_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'authentication required';
  end if;
  return v_user_id;
end;
$$;

create function private.require_member(p_role public.family_role default null)
returns public.family_members
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.family_members;
  v_user_id uuid := private.require_user();
begin
  select fm.*
  into v_member
  from public.family_members as fm
  where fm.user_id = v_user_id
    and fm.revoked_at is null;

  if v_member.id is null then
    raise exception using errcode = '42501', message = 'active family membership required';
  end if;
  if p_role is not null and v_member.role <> p_role then
    raise exception using errcode = '42501', message = p_role::text || ' role required';
  end if;
  return v_member;
end;
$$;

create function private.is_family_member(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_members as fm
    where fm.family_id = p_family_id
      and fm.user_id = auth.uid()
      and fm.revoked_at is null
  )
$$;

create function private.is_family_parent(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_members as fm
    where fm.family_id = p_family_id
      and fm.user_id = auth.uid()
      and fm.role = 'parent'
      and fm.revoked_at is null
  )
$$;

create function private.claim_operation(
  p_actor_user_id uuid,
  p_operation_key text,
  p_operation_name text,
  p_payload jsonb,
  p_family_id uuid
)
returns table (is_new boolean, prior_response jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key_hash bytea;
  v_payload_hash bytea;
  v_inserted integer;
  v_existing public.rpc_operations;
begin
  if p_actor_user_id is null or p_actor_user_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'invalid operation actor';
  end if;
  if p_operation_key is null or char_length(p_operation_key) not between 16 and 200 then
    raise exception using errcode = '22023', message = 'idempotency key must contain 16 to 200 characters';
  end if;
  if p_operation_name is null or p_operation_name !~ '^[a-z][a-z0-9_]{1,79}$' then
    raise exception using errcode = '22023', message = 'invalid operation name';
  end if;

  v_key_hash := private.operation_hash(p_operation_key);
  v_payload_hash := extensions.digest(
    pg_catalog.convert_to(coalesce(p_payload, 'null'::jsonb)::text, 'UTF8'),
    'sha256'
  );

  insert into public.rpc_operations (
    actor_user_id, operation_key_hash, operation_name, payload_hash, family_id
  ) values (
    p_actor_user_id, v_key_hash, p_operation_name, v_payload_hash, p_family_id
  )
  on conflict (actor_user_id, operation_key_hash) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    return query select true, null::jsonb;
    return;
  end if;

  select ro.*
  into v_existing
  from public.rpc_operations as ro
  where ro.actor_user_id = p_actor_user_id
    and ro.operation_key_hash = v_key_hash;

  if v_existing.operation_name <> p_operation_name
     or v_existing.payload_hash <> v_payload_hash
     or (p_family_id is not null and v_existing.family_id is distinct from p_family_id) then
    raise exception using
      errcode = '22023',
      message = 'idempotency key was already used with a different operation or payload';
  end if;
  if v_existing.response is null then
    raise exception using errcode = '40001', message = 'operation is still in progress; retry';
  end if;

  return query select false, v_existing.response;
end;
$$;

create function private.complete_operation(
  p_actor_user_id uuid,
  p_operation_key text,
  p_family_id uuid,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_response is null then
    raise exception using errcode = '22004', message = 'operation response cannot be null';
  end if;

  update public.rpc_operations
  set family_id = coalesce(family_id, p_family_id),
      response = p_response,
      completed_at = clock_timestamp()
  where actor_user_id = p_actor_user_id
    and operation_key_hash = private.operation_hash(p_operation_key)
    and response is null;

  if not found then
    raise exception using errcode = '55000', message = 'operation completion record not found';
  end if;
  return p_response;
end;
$$;

create function private.bump_revision(p_family_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  update public.families
  set revision = revision + 1,
      updated_at = clock_timestamp()
  where id = p_family_id
  returning revision into v_revision;

  if v_revision is null then
    raise exception using errcode = 'P0002', message = 'family not found';
  end if;
  return v_revision;
end;
$$;

create function private.local_date(p_family_id uuid, p_now timestamptz default clock_timestamp())
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
begin
  select fs.timezone into v_timezone
  from public.family_settings as fs
  where fs.family_id = p_family_id;
  if v_timezone is null then
    raise exception using errcode = 'P0002', message = 'family settings not found';
  end if;
  return (p_now at time zone v_timezone)::date;
end;
$$;

create function private.next_midnight(p_family_id uuid, p_date date)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
begin
  select fs.timezone into v_timezone
  from public.family_settings as fs
  where fs.family_id = p_family_id;
  return (p_date + 1)::timestamp at time zone v_timezone;
end;
$$;

create function private.log_event(
  p_family_id uuid,
  p_local_date date,
  p_type public.activity_type,
  p_message text,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.activity_events (family_id, local_date, event_type, message, created_by)
  values (p_family_id, p_local_date, p_type, left(p_message, 300), p_created_by)
  returning id into v_id;
  return v_id;
end;
$$;

create function private.stop_active_timer_internal(
  p_family_id uuid,
  p_now timestamptz,
  p_reason text,
  p_operation_hash bytea default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timer public.timer_sessions;
  v_stop_at timestamptz;
  v_used integer;
  v_status public.timer_status;
begin
  select ts.*
  into v_timer
  from public.timer_sessions as ts
  where ts.family_id = p_family_id and ts.status = 'active'
  for update;

  if v_timer.id is null then
    return null;
  end if;

  v_stop_at := least(p_now, v_timer.ends_at);
  if v_stop_at < v_timer.started_at then
    v_stop_at := v_timer.started_at;
  end if;
  v_used := greatest(0, floor(extract(epoch from (v_stop_at - v_timer.started_at)))::integer);
  v_status := case when p_now >= v_timer.ends_at then 'finished'::public.timer_status
                   else 'stopped'::public.timer_status end;

  insert into public.daily_family_states (family_id, local_date, used_seconds)
  values (p_family_id, v_timer.local_date, v_used)
  on conflict (family_id, local_date) do update
  set used_seconds = public.daily_family_states.used_seconds + excluded.used_seconds,
      updated_at = clock_timestamp();

  update public.timer_sessions
  set stopped_at = v_stop_at,
      used_seconds = v_used,
      status = v_status,
      stop_reason = left(coalesce(p_reason, 'stopped'), 120),
      stop_operation_hash = p_operation_hash,
      updated_at = clock_timestamp()
  where id = v_timer.id;

  perform private.log_event(
    p_family_id,
    v_timer.local_date,
    'timer',
    case when v_status = 'finished'
      then 'Время с телефоном завершено: ' || ceil(v_used / 60.0)::integer || ' мин'
      else 'Таймер остановлен: использовано ' || ceil(v_used / 60.0)::integer || ' мин'
    end,
    v_timer.started_by
  );

  return jsonb_build_object(
    'id', v_timer.id,
    'dayKey', v_timer.local_date::text,
    'usedSeconds', v_used,
    'status', v_status::text,
    'stoppedAt', private.epoch_ms(v_stop_at)
  );
end;
$$;

create function private.archive_day(p_family_id uuid, p_local_date date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.family_settings;
  v_day public.daily_family_states;
  v_xp integer;
  v_minutes integer;
  v_completed integer;
  v_pushups integer;
  v_required integer;
  v_required_done integer;
  v_budget_seconds integer;
  v_carried integer;
begin
  select fs.* into v_settings
  from public.family_settings as fs
  where fs.family_id = p_family_id;

  insert into public.daily_family_states (family_id, local_date)
  values (p_family_id, p_local_date)
  on conflict (family_id, local_date) do nothing;

  select dfs.* into v_day
  from public.daily_family_states as dfs
  where dfs.family_id = p_family_id and dfs.local_date = p_local_date;

  select greatest(0, coalesce(sum(rt.xp_delta), 0))::integer,
         greatest(0, coalesce(sum(rt.minutes_delta), 0))::integer
  into v_xp, v_minutes
  from public.reward_transactions as rt
  where rt.family_id = p_family_id and rt.local_date = p_local_date;

  select count(*) filter (where dts.status = 'approved')::integer
  into v_completed
  from public.daily_task_states as dts
  where dts.family_id = p_family_id and dts.local_date = p_local_date;

  select coalesce(max(dts.pushup_count) filter (where dts.status = 'approved'), 0)::integer
  into v_pushups
  from public.daily_task_states as dts
  join public.tasks as t on t.id = dts.task_id
  where dts.family_id = p_family_id
    and dts.local_date = p_local_date
    and t.task_type = 'pushups';

  select count(*)::integer,
         count(*) filter (where dts.status = 'approved')::integer
  into v_required, v_required_done
  from public.tasks as t
  left join public.daily_task_states as dts
    on dts.task_id = t.id and dts.local_date = p_local_date
  where t.family_id = p_family_id and t.active and t.required;

  v_budget_seconds := least(
    v_settings.daily_limit_minutes * 60,
    (v_day.carry_in_minutes + v_minutes) * 60
  );
  v_carried := case when v_settings.carry_over_enabled
    then floor(greatest(0, v_budget_seconds - v_day.used_seconds) / 60.0)::integer
    else 0 end;

  insert into public.history_days (
    family_id, local_date, earned_xp, earned_minutes, used_minutes,
    completed_tasks, pushup_count, minimum_met, carried_out_minutes
  ) values (
    p_family_id, p_local_date, v_xp, v_minutes,
    ceil(v_day.used_seconds / 60.0)::integer, v_completed, v_pushups,
    v_required > 0 and v_required = v_required_done, v_carried
  )
  on conflict (family_id, local_date) do update set
    earned_xp = excluded.earned_xp,
    earned_minutes = excluded.earned_minutes,
    used_minutes = excluded.used_minutes,
    completed_tasks = excluded.completed_tasks,
    pushup_count = excluded.pushup_count,
    minimum_met = excluded.minimum_met,
    carried_out_minutes = excluded.carried_out_minutes,
    updated_at = clock_timestamp();

  return v_carried;
end;
$$;

create function private.ensure_current_day(
  p_family_id uuid,
  p_now timestamptz default clock_timestamp()
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_cursor date;
  v_carry integer := 0;
  v_changed boolean := false;
  v_timer_result jsonb;
  v_guard integer := 0;
begin
  perform 1 from public.families where id = p_family_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'family not found';
  end if;

  v_today := private.local_date(p_family_id, p_now);

  select private.stop_active_timer_internal(p_family_id, p_now, 'timer finished')
  into v_timer_result
  where exists (
    select 1 from public.timer_sessions as ts
    where ts.family_id = p_family_id and ts.status = 'active' and ts.ends_at <= p_now
  );
  if v_timer_result is not null then
    v_changed := true;
  end if;

  select max(dfs.local_date) into v_cursor
  from public.daily_family_states as dfs
  where dfs.family_id = p_family_id;

  if v_cursor is null then
    insert into public.daily_family_states (family_id, local_date)
    values (p_family_id, v_today);
    v_cursor := v_today;
    v_changed := true;
  end if;

  while v_cursor < v_today and v_guard < 3700 loop
    v_carry := private.archive_day(p_family_id, v_cursor);
    v_cursor := v_cursor + 1;
    insert into public.daily_family_states (family_id, local_date, carry_in_minutes)
    values (p_family_id, v_cursor, v_carry)
    on conflict (family_id, local_date) do nothing;
    v_changed := true;
    v_guard := v_guard + 1;
  end loop;

  if v_cursor < v_today then
    raise exception using errcode = '54000', message = 'day rollover limit exceeded';
  end if;

  insert into public.daily_family_states (family_id, local_date)
  values (p_family_id, v_today)
  on conflict (family_id, local_date) do nothing;

  if v_changed then
    perform private.bump_revision(p_family_id);
  end if;
  return v_today;
end;
$$;

create function public.get_family_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member(null);
  v_family public.families;
  v_settings public.family_settings;
  v_secret public.parent_secrets;
  v_today date;
  v_now timestamptz := clock_timestamp();
  v_tasks jsonb;
  v_task_states jsonb;
  v_activity jsonb;
  v_history jsonb;
  v_transactions jsonb;
  v_active_timer jsonb;
  v_day public.daily_family_states;
  v_settings_json jsonb;
begin
  v_today := private.ensure_current_day(v_member.family_id, v_now);
  select f.* into v_family from public.families as f where f.id = v_member.family_id;
  select fs.* into v_settings from public.family_settings as fs where fs.family_id = v_member.family_id;
  select dfs.* into v_day from public.daily_family_states as dfs
    where dfs.family_id = v_member.family_id and dfs.local_date = v_today;

  if v_member.role = 'parent' then
    select ps.* into v_secret from public.parent_secrets as ps where ps.family_id = v_member.family_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.client_id,
    'title', t.title,
    'icon', t.icon,
    'xp', t.xp,
    'required', t.required,
    'builtIn', t.built_in,
    'kind', t.task_type::text,
    'hidden', not t.active,
    'createdAt', private.epoch_ms(t.created_at)
  ) order by t.sort_order, t.created_at), '[]'::jsonb)
  into v_tasks
  from public.tasks as t
  where t.family_id = v_member.family_id;

  select coalesce(jsonb_object_agg(t.client_id, jsonb_strip_nulls(jsonb_build_object(
    'id', dts.id,
    'taskId', t.client_id,
    'status', coalesce(dts.status::text, 'todo'),
    'selectedPushUps', case when t.task_type = 'pushups' then coalesce(dts.pushup_count, 10) end,
    'submittedXp', dts.submitted_xp,
    'submittedAt', private.epoch_ms(dts.requested_at),
    'resolvedAt', private.epoch_ms(dts.reviewed_at),
    'approvalRevision', coalesce(dts.approval_revision, 0),
    'activeAwardId', dts.active_award_id
  ))), '{}'::jsonb)
  into v_task_states
  from public.tasks as t
  left join public.daily_task_states as dts
    on dts.task_id = t.id and dts.local_date = v_today
  where t.family_id = v_member.family_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'type', e.event_type::text,
    'message', e.message,
    'createdAt', private.epoch_ms(e.created_at)
  ) order by e.created_at desc), '[]'::jsonb)
  into v_activity
  from (
    select ae.* from public.activity_events as ae
    where ae.family_id = v_member.family_id and ae.local_date = v_today
    order by ae.created_at desc limit 100
  ) as e;

  select coalesce(jsonb_agg(jsonb_build_object(
    'dayKey', h.local_date::text,
    'xpEarned', h.earned_xp,
    'minutesEarned', h.earned_minutes,
    'minutesUsed', h.used_minutes,
    'completedTasks', h.completed_tasks,
    'pushUps', h.pushup_count,
    'minimumMet', h.minimum_met,
    'carriedOutMinutes', h.carried_out_minutes
  ) order by h.local_date), '[]'::jsonb)
  into v_history
  from (
    select hd.* from public.history_days as hd
    where hd.family_id = v_member.family_id
    order by hd.local_date desc limit 365
  ) as h;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', rt.id,
    'dayKey', rt.local_date::text,
    'type', rt.transaction_type::text,
    'xpDelta', rt.xp_delta,
    'minutesDelta', rt.minutes_delta,
    'createdAt', private.epoch_ms(rt.created_at),
    'taskId', t.client_id,
    'reason', rt.reason,
    'reversesTransactionId', rt.reverses_transaction_id
  )) order by rt.created_at), '[]'::jsonb)
  into v_transactions
  from public.reward_transactions as rt
  left join public.tasks as t on t.id = rt.task_id
  where rt.family_id = v_member.family_id;

  select jsonb_build_object(
    'id', ts.id,
    'dayKey', ts.local_date::text,
    'startedAt', private.epoch_ms(ts.started_at),
    'endsAt', private.epoch_ms(ts.ends_at),
    'durationSeconds', ts.planned_seconds,
    'accountedSeconds', greatest(0, floor(extract(epoch from (least(v_now, ts.ends_at) - ts.started_at)))::integer),
    'lastObservedAt', private.epoch_ms(v_now)
  )
  into v_active_timer
  from public.timer_sessions as ts
  where ts.family_id = v_member.family_id and ts.status = 'active';

  v_settings_json := jsonb_build_object(
    'xpToMinutes', v_settings.xp_to_minutes,
    'dailyLimitMinutes', v_settings.daily_limit_minutes,
    'carryOver', v_settings.carry_over_enabled,
    'theme', v_settings.theme::text
  );
  if v_member.role = 'parent' then
    v_settings_json := v_settings_json || jsonb_build_object(
      'pinHash', v_secret.pin_hash,
      'pinSalt', v_secret.pin_salt,
      'hasChangedPin', v_secret.has_changed_pin
    );
  end if;

  return jsonb_build_object(
    'schemaVersion', 3,
    'revision', v_family.revision,
    'currentDayKey', v_today::text,
    'meta', jsonb_build_object(
      'familyId', v_family.id,
      'familyName', v_family.name,
      'role', v_member.role::text,
      'memberId', v_member.id,
      'displayName', v_member.display_name,
      'childName', v_family.child_name,
      'timezone', v_settings.timezone,
      'revision', v_family.revision,
      'serverTime', private.epoch_ms(v_now)
    ),
    'settings', v_settings_json,
    'tasks', v_tasks,
    'today', jsonb_build_object(
      'dayKey', v_today::text,
      'carryInMinutes', v_day.carry_in_minutes,
      'usedSeconds', v_day.used_seconds,
      'taskStates', v_task_states,
      'activity', v_activity
    ),
    'history', v_history,
    'transactions', v_transactions,
    'activeTimer', v_active_timer,
    'timerNotice', null,
    'onboardingSeen', true
  );
end;
$$;

create function public.create_family(
  p_child_name text,
  p_pin_hash text,
  p_pin_salt text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_existing public.family_members;
  v_family_id uuid;
  v_parent_member_id uuid;
  v_child_name text := regexp_replace(btrim(coalesce(p_child_name, '')), '\s+', ' ', 'g');
  v_today date;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 0)
  );
  select fm.* into v_existing
  from public.family_members as fm
  where fm.user_id = v_user_id and fm.revoked_at is null;

  if v_existing.id is not null then
    if v_existing.role <> 'parent' then
      raise exception using errcode = '42501', message = 'child account cannot create a family';
    end if;
    if not exists (
      select 1
      from public.families as f
      join public.parent_secrets as ps on ps.family_id = f.id
      where f.id = v_existing.family_id
        and f.child_name = v_child_name
        and ps.pin_hash = lower(p_pin_hash)
        and ps.pin_salt = p_pin_salt
    ) then
      raise exception using errcode = '23505', message = 'this account already owns a different family';
    end if;
    return public.get_family_snapshot();
  end if;

  if char_length(v_child_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'child name must contain 1 to 80 characters';
  end if;
  if p_pin_hash is null or lower(p_pin_hash) !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'PIN digest must be a SHA-256 hex value';
  end if;
  if p_pin_salt is null or char_length(p_pin_salt) not between 8 and 200 then
    raise exception using errcode = '22023', message = 'PIN salt must contain 8 to 200 characters';
  end if;

  insert into public.families (name, child_name)
  values ('Семья ' || v_child_name, v_child_name)
  returning id into v_family_id;

  insert into public.family_members (family_id, user_id, role, display_name)
  values (v_family_id, v_user_id, 'parent', 'Родитель')
  returning id into v_parent_member_id;

  insert into public.family_settings (family_id) values (v_family_id);
  insert into public.parent_secrets (family_id, pin_hash, pin_salt)
  values (v_family_id, lower(p_pin_hash), p_pin_salt);

  insert into public.tasks (
    family_id, client_id, title, icon, xp, required, built_in, task_type, sort_order
  ) values
    (v_family_id, 'teeth-morning', 'Почистить зубы утром', '☀️', 5, true,  true, 'standard', 10),
    (v_family_id, 'teeth-evening', 'Почистить зубы вечером', '🌙', 5, false, true, 'standard', 20),
    (v_family_id, 'make-bed', 'Заправить кровать', '🛏️', 5, true, true, 'standard', 30),
    (v_family_id, 'homework', 'Сделать школьную домашнюю работу', '📘', 20, true, true, 'standard', 40),
    (v_family_id, 'trash', 'Вынести мусор', '♻️', 10, false, true, 'standard', 50),
    (v_family_id, 'reading', 'Почитать книгу 20 минут', '📚', 15, false, true, 'standard', 60),
    (v_family_id, 'clean-room', 'Убрать комнату', '✨', 15, false, true, 'standard', 70),
    (v_family_id, 'backpack', 'Собрать школьный рюкзак', '🎒', 10, false, true, 'standard', 80),
    (v_family_id, 'good-deed', 'Сделать доброе дело без просьбы', '💛', 20, false, true, 'standard', 90),
    (v_family_id, 'pushups', 'Отжимания', '💪', 5, false, true, 'pushups', 100);

  v_today := private.local_date(v_family_id, clock_timestamp());
  insert into public.daily_family_states (family_id, local_date) values (v_family_id, v_today);
  perform private.log_event(v_family_id, v_today, 'settings', 'Семейное пространство создано', v_parent_member_id);
  perform private.bump_revision(v_family_id);
  return public.get_family_snapshot();
end;
$$;

create function public.bootstrap_parent(
  p_family_name text,
  p_parent_name text,
  p_child_name text,
  p_pin_hash text,
  p_pin_salt text,
  p_operation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  -- Compatibility entry point. Family and parent display names can be changed later;
  -- initial creation intentionally has one canonical path and unique auth.uid ownership.
  v_result := public.create_family(p_child_name, p_pin_hash, p_pin_salt);
  return v_result;
end;
$$;

create function public.create_child_invite(
  p_expires_minutes integer,
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
  v_minutes integer;
  v_token text;
  v_digest bytea;
  v_invite_id uuid;
  v_expires_at timestamptz;
  v_response jsonb;
  v_safe_response jsonb;
begin
  v_minutes := coalesce(p_expires_minutes, 60);
  if v_minutes not between 5 and 1440 then
    raise exception using errcode = '22023', message = 'invite expiry must be between 5 and 1440 minutes';
  end if;

  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'create_child_invite',
    jsonb_build_object('expiresMinutes', v_minutes), v_member.family_id
  );

  v_token := encode(extensions.digest(
    pg_catalog.convert_to(v_actor::text || ':' || p_idempotency_key || ':' || v_member.family_id::text, 'UTF8'),
    'sha256'
  ), 'hex');

  if not v_claim.is_new then
    return v_claim.prior_response || jsonb_build_object('token', v_token);
  end if;

  update public.family_invites
  set revoked_at = clock_timestamp()
  where family_id = v_member.family_id
    and used_at is null and revoked_at is null;

  v_digest := private.operation_hash(v_token);
  v_expires_at := clock_timestamp() + make_interval(mins => v_minutes);
  insert into public.family_invites (family_id, token_digest, created_by, expires_at)
  values (v_member.family_id, v_digest, v_member.id, v_expires_at)
  returning id into v_invite_id;

  perform private.log_event(
    v_member.family_id,
    private.ensure_current_day(v_member.family_id),
    'settings', 'Создана одноразовая ссылка для детского устройства', v_member.id
  );
  perform private.bump_revision(v_member.family_id);

  v_safe_response := jsonb_build_object(
    'inviteId', v_invite_id,
    'expiresAt', private.epoch_ms(v_expires_at),
    'oneTime', true
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_member.family_id, v_safe_response);
  v_response := v_safe_response || jsonb_build_object('token', v_token);
  return v_response;
end;
$$;

create function public.claim_child_invite(
  p_token text,
  p_display_name text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_user();
  v_invite public.family_invites;
  v_existing public.family_members;
  v_member_id uuid;
  v_display_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_claim record;
  v_response jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid invite token';
  end if;
  if char_length(v_display_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'display name must contain 1 to 80 characters';
  end if;

  select fi.* into v_invite
  from public.family_invites as fi
  where fi.token_digest = private.operation_hash(lower(p_token));

  if v_invite.id is null then
    raise exception using errcode = '22023', message = 'invite not found';
  end if;

  select * into v_claim
  from private.claim_operation(
    v_actor, p_idempotency_key, 'claim_child_invite',
    jsonb_build_object(
      'tokenDigest', encode(v_invite.token_digest, 'hex'),
      'displayName', v_display_name
    ),
    v_invite.family_id
  );
  if not v_claim.is_new then
    return v_claim.prior_response;
  end if;

  select fm.* into v_existing
  from public.family_members as fm
  where fm.user_id = v_actor and fm.revoked_at is null;
  if v_existing.id is not null then
    raise exception using errcode = '23505', message = 'this account already belongs to a family';
  end if;

  select fi.* into v_invite
  from public.family_invites as fi
  where fi.id = v_invite.id
  for update;
  if v_invite.used_at is not null or v_invite.revoked_at is not null then
    raise exception using errcode = '22023', message = 'invite has already been used or revoked';
  end if;
  if v_invite.expires_at <= clock_timestamp() then
    raise exception using errcode = '22023', message = 'invite has expired';
  end if;

  -- A family has one active child device. Claiming a replacement link revokes the
  -- previous child membership atomically, so an old device loses RLS/RPC access.
  update public.family_members
  set revoked_at = clock_timestamp()
  where family_id = v_invite.family_id
    and role = 'child'
    and revoked_at is null;

  insert into public.family_members (family_id, user_id, role, display_name)
  values (v_invite.family_id, v_actor, 'child', v_display_name)
  returning id into v_member_id;

  update public.family_invites
  set used_at = clock_timestamp(), claimed_by = v_member_id
  where id = v_invite.id;

  perform private.log_event(
    v_invite.family_id,
    private.ensure_current_day(v_invite.family_id),
    'settings', 'Детское устройство подключено', v_member_id
  );
  perform private.bump_revision(v_invite.family_id);

  v_response := jsonb_build_object(
    'familyId', v_invite.family_id,
    'memberId', v_member_id,
    'role', 'child'
  );
  perform private.complete_operation(v_actor, p_idempotency_key, v_invite.family_id, v_response);
  return v_response;
end;
$$;

create function public.accept_child_invite(
  p_token text,
  p_display_name text,
  p_operation_id text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.claim_child_invite(p_token, p_display_name, p_operation_id)
$$;
