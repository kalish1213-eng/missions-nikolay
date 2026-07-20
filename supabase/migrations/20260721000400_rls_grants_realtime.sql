-- RLS is defense in depth around the read model. Browser roles receive no direct
-- INSERT/UPDATE/DELETE rights; all mutations pass through the role-gated RPCs.

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.family_settings enable row level security;
alter table public.parent_secrets enable row level security;
alter table public.tasks enable row level security;
alter table public.daily_family_states enable row level security;
alter table public.daily_task_states enable row level security;
alter table public.reward_transactions enable row level security;
alter table public.timer_sessions enable row level security;
alter table public.history_days enable row level security;
alter table public.activity_events enable row level security;
alter table public.family_invites enable row level security;
alter table public.rpc_operations enable row level security;

create policy families_family_read on public.families
for select to authenticated
using (private.is_family_member(id));

create policy family_settings_family_read on public.family_settings
for select to authenticated
using (private.is_family_member(family_id));

create policy tasks_family_read on public.tasks
for select to authenticated
using (private.is_family_member(family_id));

create policy daily_family_states_family_read on public.daily_family_states
for select to authenticated
using (private.is_family_member(family_id));

create policy daily_task_states_family_read on public.daily_task_states
for select to authenticated
using (private.is_family_member(family_id));

create policy reward_transactions_family_read on public.reward_transactions
for select to authenticated
using (private.is_family_member(family_id));

create policy timer_sessions_family_read on public.timer_sessions
for select to authenticated
using (private.is_family_member(family_id));

create policy history_days_family_read on public.history_days
for select to authenticated
using (private.is_family_member(family_id));

create policy activity_events_family_read on public.activity_events
for select to authenticated
using (private.is_family_member(family_id));

-- Intentionally no client policies for family_members, parent_secrets, family_invites
-- or rpc_operations. Their safe projections are available only through RPC responses.

revoke all on all tables in schema public from anon, authenticated;
grant select on public.families,
  public.family_settings,
  public.tasks,
  public.daily_family_states,
  public.daily_task_states,
  public.reward_transactions,
  public.timer_sessions,
  public.history_days,
  public.activity_events
to authenticated;

revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on schema private from public, anon, authenticated;

-- RLS policies need only this side-effect-free membership predicate. The private
-- schema is not exposed by PostgREST, and the function reveals only the caller's membership.
grant usage on schema private to authenticated;
grant execute on function private.is_family_member(uuid) to authenticated;
grant execute on function private.is_family_parent(uuid) to authenticated;

grant execute on function public.get_family_snapshot() to authenticated;
grant execute on function public.create_family(text, text, text) to authenticated;
grant execute on function public.bootstrap_parent(text, text, text, text, text, text) to authenticated;
grant execute on function public.create_child_invite(integer, text) to authenticated;
grant execute on function public.claim_child_invite(text, text, text) to authenticated;
grant execute on function public.accept_child_invite(text, text, text) to authenticated;
grant execute on function public.submit_task(text, integer, text) to authenticated;
grant execute on function public.review_task(uuid, text, text) to authenticated;
grant execute on function public.undo_approval(uuid, text, text) to authenticated;
grant execute on function public.reverse_task_approval(uuid, text, text) to authenticated;
grant execute on function public.add_custom_task(text, integer, text) to authenticated;
grant execute on function public.update_task(text, integer, boolean, text) to authenticated;
grant execute on function public.update_family_settings(numeric, integer, boolean, text, text, text, text) to authenticated;
grant execute on function public.change_parent_pin(text, text, text) to authenticated;
grant execute on function public.adjust_xp(integer, text, text) to authenticated;
grant execute on function public.reset_today(text) to authenticated;
grant execute on function public.start_timer(integer, text) to authenticated;
grant execute on function public.stop_timer(text) to authenticated;
grant execute on function public.delete_family(text) to authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Full row images make UPDATE notifications useful; RLS still filters every Realtime event.
alter table public.families replica identity full;
alter table public.family_settings replica identity full;
alter table public.tasks replica identity full;
alter table public.daily_family_states replica identity full;
alter table public.daily_task_states replica identity full;
alter table public.reward_transactions replica identity full;
alter table public.timer_sessions replica identity full;
alter table public.history_days replica identity full;
alter table public.activity_events replica identity full;

do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array[
      'families', 'family_settings', 'tasks', 'daily_family_states',
      'daily_task_states', 'reward_transactions', 'timer_sessions',
      'history_days', 'activity_events'
    ] loop
      if not exists (
        select 1
        from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

comment on policy families_family_read on public.families is
  'Only active members can read their own family; all writes are RPC-only.';
