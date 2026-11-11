-- Run this only after creating the first administrator account in
-- Supabase Dashboard > Authentication > Users.
-- Replace the email with the exact email used for that account.
update public.profiles p
set role = 'owner', active = true
from auth.users u
where p.id = u.id
  and lower(u.email) = lower('YOUR_ADMIN_EMAIL_HERE');
