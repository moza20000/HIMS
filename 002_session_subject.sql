-- Add subject grouping without deleting or rewriting historical attendance data.
alter table public.sessions add column if not exists subject text;
update public.sessions set subject = 'غير محددة' where subject is null;
alter table public.sessions alter column subject set default 'غير محددة';
