INSERT INTO cameras (name, dept, location, camera_type, ownership, connectivity_status, storage_type, retention_days, health_status, rtsp_url) VALUES
('Kankaria Gate Cam 1', 'Traffic Police', ST_SetSRID(ST_MakePoint(72.6035, 22.9938), 4326), 'ip', 'traffic-police', 'online', 'nvr', 15, 'healthy', 'rtsp://demo/cam1'),
('CG Road Junction', 'Municipal Corp', ST_SetSRID(ST_MakePoint(72.5714, 23.0225), 4326), 'analog', 'municipal', 'online', 'cloud', 7, 'healthy', 'rtsp://demo/cam2'),
('Gandhinagar Sec 1', 'Traffic Police', ST_SetSRID(ST_MakePoint(72.6369, 23.2156), 4326), 'ip', 'traffic-police', 'offline', 'nvr', 15, 'down', 'rtsp://demo/cam3'),
('Sabarmati Riverfront', 'Municipal Corp', ST_SetSRID(ST_MakePoint(72.5797, 23.0304), 4326), 'ip', 'municipal', 'online', 'cloud', 10, 'healthy', 'rtsp://demo/cam4'),
('Maninagar Market', 'Traffic Police', ST_SetSRID(ST_MakePoint(72.6047, 22.9963), 4326), 'analog', 'traffic-police', 'online', 'nvr', 15, 'degraded', 'rtsp://demo/cam5'),
('Vastrapur Lake', 'Municipal Corp', ST_SetSRID(ST_MakePoint(72.5286, 23.0367), 4326), 'ip', 'municipal', 'online', 'cloud', 7, 'healthy', 'rtsp://demo/cam6'),
('SG Highway Junction', 'Traffic Police', ST_SetSRID(ST_MakePoint(72.5074, 23.0304), 4326), 'ip', 'traffic-police', 'online', 'nvr', 15, 'healthy', 'rtsp://demo/cam7'),
('Naroda Industrial', 'GIDC', ST_SetSRID(ST_MakePoint(72.6564, 23.0728), 4326), 'analog', 'gidc', 'offline', 'nvr', 30, 'down', 'rtsp://demo/cam8'),
('Bopal Cross Road', 'Municipal Corp', ST_SetSRID(ST_MakePoint(72.4693, 23.0335), 4326), 'ip', 'municipal', 'online', 'cloud', 10, 'healthy', 'rtsp://demo/cam9'),
('Ellis Bridge', 'Traffic Police', ST_SetSRID(ST_MakePoint(72.5726, 23.0258), 4326), 'ip', 'traffic-police', 'online', 'nvr', 15, 'healthy', 'rtsp://demo/cam10'),
('Chandkheda Metro', 'Metro Rail', ST_SetSRID(ST_MakePoint(72.5928, 23.1109), 4326), 'ip', 'metro', 'online', 'cloud', 20, 'healthy', 'rtsp://demo/cam11'),
('Paldi Circle', 'Traffic Police', ST_SetSRID(ST_MakePoint(72.5645, 22.9997), 4326), 'analog', 'traffic-police', 'online', 'nvr', 15, 'degraded', 'rtsp://demo/cam12');
