-- Parent-controlled child-session revocation.

create function public.revoke_child_device(p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.family_members := private.require_member('parent');
  v_actor uuid := auth.uid();
  v_claim record;
  v_revoked integer;
  v_revision bigint;
  v_response jsonb;
begin
  select * into v_claim from private.claim_operation(
    v_actor,
    p_idempotency_key,
    'revoke_child_device',
    '{}'::jsonb,
    v_member.family_id
  );
  if not v_claim.is_new then return v_claim.prior_response; end if;

  update public.family_members
  set revoked_at = clock_timestamp()
  where family_id = v_member.family_id
    and role = 'child'
    and revoked_at is null;
  get diagnostics v_revoked = row_count;

  update public.family_invites
  set revoked_at = clock_timestamp()
  where family_id = v_member.family_id
    and used_at is null
    and revoked_at is null;

  perform private.log_event(
    v_member.family_id,
    private.ensure_current_day(v_member.family_id),
    'settings',
    case when v_revoked > 0
      then 'Доступ детского устройства отозван'
      else 'Открытые приглашения детского устройства отозваны'
    end,
    v_member.id
  );
  v_revision := private.bump_revision(v_member.family_id);
  v_response := jsonb_build_object(
    'revokedDevices', v_revoked,
    'revision', v_revision
  );
  perform private.complete_operation(
    v_actor, p_idempotency_key, v_member.family_id, v_response
  );
  return v_response;
end;
$$;

revoke all on function public.revoke_child_device(text) from public, anon, authenticated;
grant execute on function public.revoke_child_device(text) to authenticated;

comment on function public.revoke_child_device(text) is
  'Parent-only, idempotent revocation of the active child membership and open invites.';
