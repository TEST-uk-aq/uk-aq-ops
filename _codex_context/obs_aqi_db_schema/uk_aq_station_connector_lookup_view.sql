-- Focused apply file for the AQI worker station -> connector lookup view.

create schema if not exists uk_aq_public;

create or replace view uk_aq_public.uk_aq_station_connector_lookup as
select
  id as station_id,
  connector_id
from uk_aq_core.stations;

alter view if exists uk_aq_public.uk_aq_station_connector_lookup set (security_invoker = true);

revoke all on uk_aq_public.uk_aq_station_connector_lookup from public;
grant select on uk_aq_public.uk_aq_station_connector_lookup to service_role;
