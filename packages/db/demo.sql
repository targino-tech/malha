INSERT INTO farms (org_id, id, name, location, latitude, longitude) VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'Fazenda Horizonte', 'Sorriso · MT', -12.545, -55.711),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', 'Fazenda Vale Verde', 'Sinop · MT', -11.864, -55.502),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', 'Fazenda Santa Luzia', 'Juara · MT', -11.255, -57.520);

INSERT INTO collector_keys (key_id, collector_id, org_id, farm_id, public_key) VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', '{}'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', '{}');

INSERT INTO collector_health (org_id, farm_id, collector_id, last_heartbeat_at, last_capture_at, healthy) VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000301', now(), now(), true),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000302', now() - interval '12 minutes', now() - interval '15 minutes', false);

INSERT INTO assets (org_id, farm_id, id, name, category, tag, ip, mac, critical, source, status, last_observed_at, last_collector_id) VALUES
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000401','Balança do armazém','Balança','HZ-BAL-01','10.40.1.12',NULL,true,'csv','unknown',NULL,NULL),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000402','Tablet de campo','Tablet','HZ-TAB-02',NULL,NULL,false,'csv','unknown',NULL,NULL),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000403','Rádio do pátio','Rádio','HZ-RAD-03',NULL,NULL,false,'csv','unknown',NULL,NULL),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000404','Switch do armazém','Switch','VV-SW-01','10.42.2.3','02:00:00:0a:02:03',true,'unifi','offline',now(),'00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000405','AP da portaria','Ponto de acesso','VV-AP-02','10.42.2.7','02:00:00:0a:02:07',true,'unifi','online',now(),'00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000406','Gateway da unidade','Gateway','VV-GW-01','10.42.2.1','02:00:00:0a:02:01',true,'unifi','online',now(),'00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000407','AP da oficina','Ponto de acesso','SL-AP-01','10.48.3.5','02:00:00:0a:03:05',false,'unifi','online',now() - interval '15 minutes','00000000-0000-4000-8000-000000000302'),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000408','Câmera da portaria','Câmera','SL-CAM-02','10.48.3.9',NULL,true,'csv','unknown',NULL,NULL);

-- Histórico fictício de 30 dias para os gráficos do demo: episódios já encerrados automaticamente.
INSERT INTO occurrences (org_id, farm_id, id, rule, resource_kind, resource_id, severity, title, first_observed_at, opened_at, resolved_at, resolution)
SELECT '00000000-0000-4000-8000-000000000001', e.farm_id, gen_random_uuid(), e.rule, e.kind, e.resource_id, e.severity, e.title,
  now() - make_interval(days => e.days_ago, mins => e.minutes + 3),
  now() - make_interval(days => e.days_ago, mins => e.minutes),
  now() - make_interval(days => e.days_ago), 'auto'
FROM (VALUES
  ('00000000-0000-4000-8000-000000000103'::uuid, 'collector_silent', 'collector', '00000000-0000-4000-8000-000000000302'::uuid, 'critical', 'Coletor sem contato', 3, 85),
  ('00000000-0000-4000-8000-000000000103'::uuid, 'collector_silent', 'collector', '00000000-0000-4000-8000-000000000302'::uuid, 'critical', 'Coletor sem contato', 8, 40),
  ('00000000-0000-4000-8000-000000000103'::uuid, 'collector_silent', 'collector', '00000000-0000-4000-8000-000000000302'::uuid, 'critical', 'Coletor sem contato', 12, 190),
  ('00000000-0000-4000-8000-000000000103'::uuid, 'collector_silent', 'collector', '00000000-0000-4000-8000-000000000302'::uuid, 'critical', 'Coletor sem contato', 19, 25),
  ('00000000-0000-4000-8000-000000000103'::uuid, 'collector_silent', 'collector', '00000000-0000-4000-8000-000000000302'::uuid, 'critical', 'Coletor sem contato', 26, 310),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'collector_silent', 'collector', '00000000-0000-4000-8000-000000000301'::uuid, 'critical', 'Coletor sem contato', 14, 18),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'asset_offline', 'asset', '00000000-0000-4000-8000-000000000404'::uuid, 'critical', 'Ativo offline: Switch do armazém', 2, 35),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'asset_offline', 'asset', '00000000-0000-4000-8000-000000000404'::uuid, 'critical', 'Ativo offline: Switch do armazém', 6, 12),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'asset_offline', 'asset', '00000000-0000-4000-8000-000000000404'::uuid, 'critical', 'Ativo offline: Switch do armazém', 15, 48),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'asset_offline', 'asset', '00000000-0000-4000-8000-000000000405'::uuid, 'critical', 'Ativo offline: AP da portaria', 22, 20),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'capture_stale', 'collector', '00000000-0000-4000-8000-000000000301'::uuid, 'warning', 'Coleta UniFi desatualizada', 5, 22),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'capture_stale', 'collector', '00000000-0000-4000-8000-000000000301'::uuid, 'warning', 'Coleta UniFi desatualizada', 10, 30),
  ('00000000-0000-4000-8000-000000000103'::uuid, 'capture_stale', 'collector', '00000000-0000-4000-8000-000000000302'::uuid, 'warning', 'Coleta UniFi desatualizada', 17, 45),
  ('00000000-0000-4000-8000-000000000102'::uuid, 'capture_stale', 'collector', '00000000-0000-4000-8000-000000000301'::uuid, 'warning', 'Coleta UniFi desatualizada', 24, 16),
  ('00000000-0000-4000-8000-000000000103'::uuid, 'capture_stale', 'collector', '00000000-0000-4000-8000-000000000302'::uuid, 'warning', 'Coleta UniFi desatualizada', 28, 60)
) AS e(farm_id, rule, kind, resource_id, severity, title, days_ago, minutes);
