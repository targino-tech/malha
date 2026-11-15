-- Diferença entre o relógio do coletor (iat da prova assinada) e o horário de recebimento, em segundos.
-- Negativo: coletor atrasado. A conexão usa a hora recebida; este valor só apoia o diagnóstico.
ALTER TABLE collector_health ADD COLUMN clock_skew_seconds integer;
