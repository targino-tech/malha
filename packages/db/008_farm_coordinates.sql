-- Coordenadas opcionais da sede da fazenda, para o mapa do parque tecnológico.
ALTER TABLE farms ADD COLUMN latitude double precision CHECK (latitude BETWEEN -90 AND 90);
ALTER TABLE farms ADD COLUMN longitude double precision CHECK (longitude BETWEEN -180 AND 180);
ALTER TABLE farms ADD CONSTRAINT farms_coordinates_pair CHECK ((latitude IS NULL) = (longitude IS NULL));
