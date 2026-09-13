const LABELS: Record<string, string> = {
  pending: 'pendente',
  running: 'em execução',
  done: 'concluído',
  failed: 'falhou',
  cancelled: 'cancelado',
  success: 'sucesso',
  blocked: 'bloqueado',
  timeout: 'tempo esgotado',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{LABELS[status] ?? status}</span>;
}
