-- Invite to ride (the owner, 2026-09-30): a community application can be answered with an
-- invitation to a Saturday Social Ride instead of a membership. Staff pick the ride (and any tags,
-- none ticked to start with); the app approves the application through staff_community_approve
-- with p_community false (20260929150000), books the rider onto that ride's Final list, and writes
-- the invitation message.
--
-- invited_session is the ride it booked (a sessions.id), written by the Invite dialog right after
-- the approval; null for a plain approval. The card then reads Invited, under a list of its own,
-- and can write the invitation again. A plain column, no foreign key: a session deleted later
-- leaves the id behind and the card says "Invited to a Saturday Social Ride" without the day.
--
-- No new grants: staff already read and update community_applications ("staff read applications",
-- "staff update applications", table-level SELECT/UPDATE for authenticated); anon has none.

begin;

alter table public.community_applications add column if not exists invited_session text;

comment on column public.community_applications.invited_session is
  'The Saturday Social Ride an Invite to ride booked the applicant on (sessions.id); null for a plain approval.';

commit;
