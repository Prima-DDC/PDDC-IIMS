-- PDDC IIMS 0014 : reading names and emails from the shared directory.
--
-- THE BUG THIS FIXES
-- The user repository joined public.profiles directly to get each person's
-- name, email and photo. iims_app does hold SELECT on that table, but the
-- WEBSITE'S own row-level security policy on it reads
--
--     id = auth.uid() or public.is_admin()
--
-- and auth.uid() is null on a direct Postgres connection. So the join matched
-- nothing: every user in the administration list rendered as "Name not set"
-- with an empty email, and searching by name or email matched nobody.
--
-- Found by the end-to-end suite, which looked for a seeded user by name in the
-- list and could not find it. The data was correct all along; the read was
-- being filtered out by a policy belonging to the other application.
--
-- The IIMS must not change that policy, because primaddc.com depends on it.
-- So the directory is read through this SECURITY DEFINER function instead,
-- exactly as resolve_actor and directory_profiles already do.

-- Changing the return type means replacing the function.
drop function if exists iam.display_names(uuid[]);

create or replace function iam.profile_basics(p_ids uuid[])
  returns table (
    user_id    uuid,
    email      text,
    full_name  text,
    photo_path text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  -- Falls back to auth.users.email so a person who somehow has no profile row
  -- still shows an address rather than a blank.
  select
    au.id,
    coalesce(p.email, au.email::text),
    p.full_name,
    p.photo_path
  from auth.users au
  left join public.profiles p on p.id = au.id
  where au.id = any(p_ids)
$$;

comment on function iam.profile_basics(uuid[]) is
  'Name, email and photo for a set of users, read from the shared primaddc.com '
  'directory. SECURITY DEFINER because the website owns public.profiles and '
  'its RLS policy keys on auth.uid(), which is null on a direct connection.';

grant execute on function iam.profile_basics(uuid[]) to iims_app;
