-- Release hardening found by the independent pre-publication audit.

-- Parent ownership must be backed by a non-anonymous Auth identity. Anonymous
-- sessions remain available only for one-time child-device enrollment.
create function private.reject_anonymous_family_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then
    raise exception using
      errcode = '42501',
      message = 'a verified parent email session is required to create a family';
  end if;
  return new;
end;
$$;

create trigger families_require_non_anonymous_owner
before insert on public.families
for each row execute function private.reject_anonymous_family_insert();

-- Serialise all idempotent family mutations before their first side effect.
-- This makes two concurrent invite creations deterministic: the later request
-- revokes the earlier open invite before creating its own.
create function private.lock_family_rpc_operation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.family_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.family_id::text, 13)
    );
  end if;
  return new;
end;
$$;

create trigger rpc_operations_family_lock
before insert on public.rpc_operations
for each row execute function private.lock_family_rpc_operation();

-- The index is an independent invariant in case a future mutation path omits
-- the lock. Expired-but-unclaimed rows are revoked by create_child_invite.
create unique index family_invites_one_open_per_family
  on public.family_invites (family_id)
  where used_at is null and revoked_at is null;

comment on index public.family_invites_one_open_per_family is
  'At most one unclaimed, non-revoked child invite may exist for a family.';
