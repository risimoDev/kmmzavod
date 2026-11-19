BEGIN;

-- Keep current account links during the switchover, but exclude retired endpoints from new assignments.
WITH legacy_ports AS (
  SELECT port
  FROM "admin_settings" AS settings
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(settings."value") = 'array' THEN settings."value" ELSE '[]'::jsonb END
  ) AS ports(port)
  WHERE settings."key" = 'ASTROPROXY_CACHED_PORTS'
)
UPDATE "proxies" AS proxy
SET "is_active" = FALSE
WHERE (proxy."host" = '45.81.32.208' AND proxy."port" = 10018)
   OR lower(rtrim(proxy."host", '.')) ~ '(^|[.])astroproxy[.]com$'
   OR EXISTS (
     SELECT 1
     FROM legacy_ports
     WHERE port->>'host' = proxy."host"
       AND proxy."port"::text IN (port->>'port', port->>'socksPort')
   );

DELETE FROM "admin_settings"
WHERE "key" IN (
  'ASTROPROXY_API_TOKEN',
  'ASTROPROXY_CACHED_PORTS',
  'ASTROPROXY_CACHED_BALANCE'
);

COMMIT;
