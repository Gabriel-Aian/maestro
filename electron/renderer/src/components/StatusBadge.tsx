const LABELS: Record<string, string> = {
  pending: 'pendente',
  running: 'em execução',
  done: 'concluído',
  failed: 'falhou',
  cancelled: 'cancelado',
  success: 'sucesso',
  blocked: 'bloqueado',
  timeout: 'tempo esgotado',
  authenticated: 'autenticado',
  session_expired: 'sessão expirada',
  never_authenticated: 'nunca autenticado',
};

/**
 * Nem todo status tem sua própria cor — perfis usam um vocabulário diferente
 * de jobs/execuções (RN-003/RN-004), mas a intenção visual é a mesma:
 * `authenticated` ~ sucesso, `session_expired` ~ falha, `never_authenticated`
 * é neutro. Mapeia para uma cor já existente em vez de duplicar CSS.
 */
const KIND: Record<string, string> = {
  authenticated: 'done',
  session_expired: 'failed',
  never_authenticated: 'cancelled',
};

export function StatusBadge({ status }: { status: string }) {
  const kind = KIND[status] ?? status;
  return <span className={`badge badge-${kind}`}>{LABELS[status] ?? status}</span>;
}
