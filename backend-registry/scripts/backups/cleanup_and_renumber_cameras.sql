BEGIN;

CREATE TEMP TABLE id_remap (old_id INT, new_id INT);
INSERT INTO id_remap (old_id, new_id) VALUES
(43,1),(44,2),(45,3),(46,4),(47,5),(48,6),(49,7),(50,8),(51,9),(52,10),
(89,11),(90,12),(91,13),(92,14),(93,15),(94,16),(95,17),(96,18),(97,19),(98,20),
(99,21),(100,22),(109,23),(110,24),(111,25),(104,26),(105,27),(106,28),(107,29),(108,30);

DELETE FROM cameras WHERE id NOT IN (SELECT old_id FROM id_remap);

ALTER TABLE camera_status_history DROP CONSTRAINT camera_status_history_camera_id_fkey;

UPDATE camera_status_history csh SET camera_id = r.new_id FROM id_remap r WHERE csh.camera_id = r.old_id;
UPDATE cameras c SET id = r.new_id FROM id_remap r WHERE c.id = r.old_id;

ALTER TABLE camera_status_history
  ADD CONSTRAINT camera_status_history_camera_id_fkey
  FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE;

SELECT setval('cameras_id_seq', 30, true);

COMMIT;
