-- Zeitplan: die Engine tickt alle 15 Sekunden (14.1), auch wenn niemand die App offen hat.
-- In Supabase: Database > Extensions > pg_cron muss aktiv sein (dieses Skript versucht es selbst).

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'hunt-mode-tick';
  perform cron.schedule('hunt-mode-tick', '15 seconds', 'select public.engine_tick_all()');
end $$;

-- Standortdaten nach Ablauf der Aufbewahrungsfrist löschen (Kapitel 15).
create or replace function public.purge_old_locations()
returns void language sql security definer set search_path = public as $$
  delete from public.location_samples s using public.games g
  where s.game_id = g.id and g.status in ('beendet', 'archiviert')
    and g.ended_at < now() - make_interval(days => public.cfg_int(g.config_json, 'privacy', 'retention_days', 30));
$$;
revoke execute on function public.purge_old_locations() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'hunt-mode-purge';
  perform cron.schedule('hunt-mode-purge', '17 3 * * *', 'select public.purge_old_locations()');
end $$;
