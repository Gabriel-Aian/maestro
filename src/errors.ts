import { ZodError } from 'zod';

/**
 * `ZodError.message` é o array de issues inteiro serializado em JSON — ótimo
 * para depurar, péssimo para mostrar a um usuário (visto ao vivo: um valor
 * fora do intervalo permitido em `AppConfigSchema` chegava na tela de
 * Configurações como `[ { "code": "too_big", ... } ]` cru). Formata como uma
 * lista curta "campo: mensagem", mesmo estilo de `SearchFileInvalidError`.
 * Usada tanto pela CLI (`fail(...)`) quanto pelos handlers de IPC da GUI —
 * um único lugar para nunca mais vazar JSON de validação para quem usa o app.
 */
export function formatError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((issue) => `${issue.path.length ? issue.path.join('.') : '(raiz)'}: ${issue.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
