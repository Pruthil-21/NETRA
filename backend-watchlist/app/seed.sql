INSERT INTO watchlist (plate_number, reason, dept_flagged, priority) VALUES
('GJ01AB1234', 'Stolen vehicle', 'Traffic Police', 'high'),
('GJ05CD5678', 'Wanted - theft case', 'Ahmedabad City Police', 'high'),
('GJ18EF9012', 'Suspicious activity report', 'Gandhinagar Police', 'medium'),
('GJ27GH3456', 'Stolen vehicle', 'Vadodara Police', 'high'),
('GJ01IJ7890', 'Outstanding warrant', 'Traffic Police', 'medium'),
('GJ06KL2345', 'Wanted - fraud case', 'Surat Police', 'high'),
('GJ18MN6789', 'Suspicious activity report', 'Gandhinagar Police', 'low'),
('GJ27OP0123', 'Stolen vehicle', 'Vadodara Police', 'high'),
('GJ01QR4567', 'Wanted - assault case', 'Ahmedabad City Police', 'high'),
('GJ05ST8901', 'Outstanding warrant', 'Traffic Police', 'medium');

INSERT INTO alerts (camera_id, plate_number, watchlist_id, status) VALUES
(1, 'GJ01AB1234', 1, 'NEW'),
(4, 'GJ05CD5678', 2, 'NEW');
