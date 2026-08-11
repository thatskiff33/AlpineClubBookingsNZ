-- Seed the Other Lodges registry with the club's recognised external / partner
-- lodges (#2749). Additive data seed, NOT a data rewrite: one INSERT ... VALUES
-- with ON CONFLICT ("name") DO NOTHING, so it is:
--   * idempotent — safe to (re)apply on a database that already holds these rows
--     (e.g. the club's existing deployment where they were entered via the admin
--     UI); it inserts nothing there and never overwrites an admin's later edits;
--   * a fresh-install populator — a brand-new database gets the full list.
-- The check-data-migration-verification gate does NOT require a fixture: a plain
-- INSERT ... VALUES adds rows and cannot alter anything a club has typed (the
-- ON CONFLICT is DO NOTHING, not DO UPDATE).
--
-- Values (ids + timestamps included) are copied verbatim from the club's
-- database so the seed reproduces its exact current state, deterministically.

INSERT INTO "OtherLodge" (id, name, location, "bookingOfficerName", "bookingOfficerEmail", "bookingOfficerPhone", "bedCapacity", "createdAt", "updatedAt") VALUES 
  ('cmsmjgnx10006eotzrmxnncx3', 'Alpine Sports Club (A Frame)', 'Iwikau Village', NULL, 'ruapehu@alpinesport.org.nz', NULL, 20, '2026-08-10 01:14:21.589', '2026-08-10 01:39:03.79'),
  ('cmsmjgxcd0008eotzp91hix2q', 'Aorangi Ski Club', 'Lower Iwikau Village', NULL, 'bookings@aorangiski.co.nz', NULL, 32, '2026-08-10 01:14:33.805', '2026-08-10 01:34:47.697'),
  ('cmsmjh9df000aeotzbrth8nb3', 'Arlberg Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:14:49.395', '2026-08-10 01:14:49.395'),
  ('cmsmjhqc7000geotza5o6l8f9', 'Boomerang Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:15:11.383', '2026-08-10 01:15:11.383'),
  ('cmsmjhyd9000ieotz8rqekcs0', 'Central Plateau Schools Alpine Charitable Trust', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:15:21.789', '2026-08-10 01:15:21.789'),
  ('cmsmji49b000keotzeydrqs5n', 'Christiania Ski Club', 'Salt Ridge, Iwikau Village', NULL, 'bookings@christiania.org.nz', NULL, 36, '2026-08-10 01:15:29.424', '2026-08-10 01:35:02.445'),
  ('cmsmji9ia000meotzxoy3swgv', 'Graduates Ski Club', 'Iwikau Village', NULL, NULL, NULL, 30, '2026-08-10 01:15:36.226', '2026-08-10 01:35:28.214'),
  ('cmsmjifk9000oeotzb52m9t31', 'Havelock Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:15:44.073', '2026-08-10 01:15:44.073'),
  ('cmsmjiluj000qeotzvzdq0c7m', 'Hawkes Bay Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:15:52.219', '2026-08-10 01:15:52.219'),
  ('cmsmjiqrr000seotz9uc2moqv', 'Hutt Valley Tramping Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:15:58.599', '2026-08-10 01:15:58.599'),
  ('cmsmjiva7000ueotzs6uflnwm', 'Iwikau Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:16:04.447', '2026-08-10 01:16:04.447'),
  ('cmsmjjj6a000weotz1jv7vmfb', 'Levin Waiopehu Tramping Club', 'Iwikau Village', NULL, 'bookings@lwtc.org.nz', NULL, 32, '2026-08-10 01:16:35.41', '2026-08-10 01:35:52.779'),
  ('cmsmjjor7000yeotzru1amyf6', 'Manawatu Tramping & Skiing Club', '500m W of Bruce Rd top', NULL, NULL, NULL, 32, '2026-08-10 01:16:42.643', '2026-08-10 01:36:25.164'),
  ('cmsmjju410010eotzw3r9pq88', 'Massey University Alpine Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:16:49.585', '2026-08-10 01:16:49.585'),
  ('cmsmjjzna0012eotzk36q39tb', 'Matamata Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:16:56.758', '2026-08-10 01:16:56.758'),
  ('cmsmjkd9j0016eotzco6ug7kx', 'NZ Alpine Club (Ruapehu Hut)', 'Delta Ridge', NULL, 'office@alpineclub.org.nz', NULL, 20, '2026-08-10 01:17:14.407', '2026-08-10 01:38:34.584'),
  ('cmsmjk50h0014eotzp3ptidmp', 'Ngauruhoe Ski Club', 'Top of Bruce Road Loop', NULL, 'bookings@ngauruhoe.org.nz', NULL, 40, '2026-08-10 01:17:03.713', '2026-08-10 01:37:27.851'),
  ('cmsmjkk370018eotzhw793gno', 'Otaihape Alpine Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:17:23.251', '2026-08-10 01:17:23.251'),
  ('cmsmjkovo001aeotzj60vjd2a', 'Pinnacle Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:17:29.46', '2026-08-10 01:17:29.46'),
  ('cmsmjkv69001ceotzz4kclq4g', 'Puketoi Mountain Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:17:37.617', '2026-08-10 01:17:37.617'),
  ('cmsmjl09q001eeotztg4lupy0', 'Rangatira Alpine Sports Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:17:44.222', '2026-08-10 01:17:44.222'),
  ('cmsmjl5v7001geotzmh5me7yq', 'Rotorua Tramping & Skiing Club', 'Whakapapa Village', NULL, 'bookings@rotoruatrampski.co.nz', NULL, 28, '2026-08-10 01:17:51.475', '2026-08-10 01:39:33.665'),
  ('cmsmjlews001ieotzq6omo3oq', 'Royal Forest & Bird Protection Society', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:18:03.197', '2026-08-10 01:18:03.197'),
  ('cmsmjlk4q001keotzf0jsxxqk', 'Ruapehu Ski Club (4 Lodges)', 'Hut Flat, Whakapapa', NULL, 'admin@rsc.org.nz', NULL, 67, '2026-08-10 01:18:09.962', '2026-08-10 01:42:09.313'),
  ('cmsmjlo8n001meotzkte1y7lw', 'Scout Association of New Zealand', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:18:15.287', '2026-08-10 01:18:15.287'),
  ('cmsmjlsqe001oeotzakiouq1z', 'Serac Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:18:21.11', '2026-08-10 01:18:21.11'),
  ('cmsmjlx49001qeotzo75pi0p1', 'Ski Racers Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:18:26.793', '2026-08-10 01:18:26.793'),
  ('cmsmjm1ky001seotzjnjp7nrq', 'Skyline Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:18:32.578', '2026-08-10 01:18:32.578'),
  ('cmsmjm6l5001ueotzrbggks50', 'Snowline Ski Club', 'Bruce Rd (penultimate left)', NULL, NULL, NULL, NULL, '2026-08-10 01:18:39.065', '2026-08-10 01:42:50.17'),
  ('cmsmjmbwd001weotza2svu5yd', 'Summit Skiers', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:18:45.949', '2026-08-10 01:18:45.949'),
  ('cmsmjmgqw001yeotz6wwjcsmu', 'Tahurangi Ski Club', 'Iwikau Village', NULL, NULL, NULL, 32, '2026-08-10 01:18:52.232', '2026-08-10 01:43:19.504'),
  ('cmsmjmlgc0020eotzfb92stgb', 'Takapuna Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:18:58.332', '2026-08-10 01:18:58.332'),
  ('cmsmjmq9x0022eotzhcwafgsf', 'Tararua Tramping Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:19:04.581', '2026-08-10 01:19:04.581'),
  ('cmsmjmv540024eotz7hwearit', 'Taupo Ski Club', 'Bruce Rd Loop (3rd left)', NULL, 'bookings@tauposki.nz', NULL, 35, '2026-08-10 01:19:10.888', '2026-08-10 01:44:18.706'),
  ('cmsmjmzjn0026eotzgx5ywhee', 'Tauranga Ski Club', 'Upper Whakapapa Skifield', NULL, NULL, NULL, 30, '2026-08-10 01:19:16.595', '2026-08-10 01:43:52.138'),
  ('cmsmjn4ib0028eotzeo4hiqzi', 'Tauwira Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:19:23.027', '2026-08-10 01:19:23.027'),
  ('cmsmjn99c002aeotzbj3neq04', 'Te Horonuku Mountain Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:19:29.184', '2026-08-10 01:19:29.184'),
  ('cmsmjnf9t002ceotz7xtp291t', 'The Scripture Union in NZ', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:19:36.977', '2026-08-10 01:19:36.977'),
  ('cmsmjnkt5002eeotzhflruxqm', 'Tokoroa Alpine Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:19:44.153', '2026-08-10 01:19:44.153'),
  ('cmsmjnppy002geotzzuq0dy0v', 'Tongariro Ski Club', 'Iwikau Village', NULL, 'bookings@tongariro.org.nz', NULL, 40, '2026-08-10 01:19:50.518', '2026-08-10 01:44:46.827'),
  ('cmsmjnubb002ieotzhnzkci48', 'Tukino Alpine Sports Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:19:56.471', '2026-08-10 01:19:56.471'),
  ('cmsmjnzlx002keotzu25jdd0w', 'University of Auckland Snowsports Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:20:03.333', '2026-08-10 01:20:03.333'),
  ('cmsmjo54c002meotz7o05jm84', 'Waikato Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:20:10.476', '2026-08-10 01:20:10.476'),
  ('cmsmjo9b7002oeotz3jc7kiiw', 'Waikato Tramping Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:20:15.907', '2026-08-10 01:20:15.907'),
  ('cmsmjodq0002qeotz5u2cpxrw', 'Waitomo Ski Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:20:21.624', '2026-08-10 01:20:21.624'),
  ('cmsmjoiwz002seotzww45zb9w', 'Wellington Catholic Tramping Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:20:28.355', '2026-08-10 01:20:28.355'),
  ('cmsmjooau002ueotzpq2q7sif', 'Wellington Tramping & Mountaineering Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:20:35.334', '2026-08-10 01:20:35.334'),
  ('cmsmjotxz002weotz1z24lr8m', 'Whakapapa Mountain Club', 'Salt Ridge / Upper Village', NULL, 'wmcbookingofficer@gmail.com', NULL, 32, '2026-08-10 01:20:42.647', '2026-08-10 01:45:15.21'),
  ('cmsmjp2w4002yeotz2uky62gy', 'Whanganui Ski & Snowboard Club', NULL, NULL, NULL, NULL, NULL, '2026-08-10 01:20:54.245', '2026-08-10 01:20:54.245')
ON CONFLICT ("name") DO NOTHING;
