import { useEffect, useState } from 'react';
import type { AppConfigView } from '../../../shared/ipc.js';

interface ConfigFormState {
  defaultHeadless: boolean;
  defaultTimeoutMs: string;
  defaultMaxRetries: string;
  viewportWidth: string;
  viewportHeight: string;
  stepDelayMin: string;
  stepDelayMax: string;
  captureTrace: boolean;
  detectLoginWall: boolean;
  maxAgeDays: string;
  maxRuns: string;
  failureMultiplier: string;
  diskWarningMb: string;
  maxConcurrentBrowsers: string;
  jobTimeoutMs: string;
  jobDelayMin: string;
  jobDelayMax: string;
  browserIdleTtlMs: string;
}

function toForm(config: AppConfigView): ConfigFormState {
  return {
    defaultHeadless: config.defaultHeadless,
    defaultTimeoutMs: String(config.defaultTimeoutMs),
    defaultMaxRetries: String(config.defaultMaxRetries),
    viewportWidth: String(config.defaultViewport.width),
    viewportHeight: String(config.defaultViewport.height),
    stepDelayMin: String(config.defaultStepDelayMs[0]),
    stepDelayMax: String(config.defaultStepDelayMs[1]),
    captureTrace: config.captureTrace,
    detectLoginWall: config.detectLoginWall,
    maxAgeDays: String(config.retention.maxAgeDays),
    maxRuns: String(config.retention.maxRuns),
    failureMultiplier: String(config.retention.failureMultiplier),
    diskWarningMb: String(config.retention.diskWarningMb),
    maxConcurrentBrowsers: String(config.maxConcurrentBrowsers),
    jobTimeoutMs: String(config.jobTimeoutMs),
    jobDelayMin: String(config.jobDelayMs[0]),
    jobDelayMax: String(config.jobDelayMs[1]),
    browserIdleTtlMs: String(config.browserIdleTtlMs),
  };
}

/**
 * A validação de verdade (min/max/inteiro) é o `AppConfigSchema.parse` do
 * lado do main — aqui só garante que todo campo numérico é um número, para
 * dar um erro claro antes de round-trip nenhum. Se a String virar NaN,
 * devolve null e quem chamou mostra o aviso.
 */
function fromForm(form: ConfigFormState): AppConfigView | null {
  const fields = {
    defaultTimeoutMs: Number(form.defaultTimeoutMs),
    defaultMaxRetries: Number(form.defaultMaxRetries),
    viewportWidth: Number(form.viewportWidth),
    viewportHeight: Number(form.viewportHeight),
    stepDelayMin: Number(form.stepDelayMin),
    stepDelayMax: Number(form.stepDelayMax),
    maxAgeDays: Number(form.maxAgeDays),
    maxRuns: Number(form.maxRuns),
    failureMultiplier: Number(form.failureMultiplier),
    diskWarningMb: Number(form.diskWarningMb),
    maxConcurrentBrowsers: Number(form.maxConcurrentBrowsers),
    jobTimeoutMs: Number(form.jobTimeoutMs),
    jobDelayMin: Number(form.jobDelayMin),
    jobDelayMax: Number(form.jobDelayMax),
    browserIdleTtlMs: Number(form.browserIdleTtlMs),
  };
  if (Object.values(fields).some((n) => Number.isNaN(n))) return null;

  return {
    defaultHeadless: form.defaultHeadless,
    defaultTimeoutMs: fields.defaultTimeoutMs,
    defaultMaxRetries: fields.defaultMaxRetries,
    defaultViewport: { width: fields.viewportWidth, height: fields.viewportHeight },
    maxConcurrentBrowsers: fields.maxConcurrentBrowsers,
    jobTimeoutMs: fields.jobTimeoutMs,
    browserIdleTtlMs: fields.browserIdleTtlMs,
    defaultStepDelayMs: [fields.stepDelayMin, fields.stepDelayMax],
    jobDelayMs: [fields.jobDelayMin, fields.jobDelayMax],
    retention: {
      maxAgeDays: fields.maxAgeDays,
      maxRuns: fields.maxRuns,
      failureMultiplier: fields.failureMultiplier,
      diskWarningMb: fields.diskWarningMb,
    },
    captureTrace: form.captureTrace,
    detectLoginWall: form.detectLoginWall,
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ fontSize: 12.5, display: 'block' }}>
      {label}
      {hint && <span className="text-muted"> ({hint})</span>}
      <br />
      {children}
    </label>
  );
}

function NumberInput({ value, onChange, width = 90 }: { value: string; onChange: (v: string) => void; width?: number }) {
  return <input type="text" className="mono" value={value} onChange={(e) => onChange(e.target.value)} style={{ marginTop: 4, width }} />;
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ fontSize: 13, display: 'block', marginBottom: 10 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function SettingsScreen() {
  const [form, setForm] = useState<ConfigFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.maestro.getConfig().then((c) => setForm(toForm(c)));
  }, []);

  function set<K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]): void {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (!form) return;
    const parsed = fromForm(form);
    if (!parsed) {
      setError('Algum campo numérico está vazio ou não é um número válido.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await window.maestro.updateConfig(parsed);
      if (result.ok) {
        setForm(toForm(result.config));
        setSaved(true);
      } else {
        setError(result.reason);
      }
    } finally {
      setSaving(false);
    }
  }

  async function restoreDefaults(): Promise<void> {
    const defaults = await window.maestro.getDefaultConfig();
    setForm(toForm(defaults));
    setSaved(false);
    setError(null);
  }

  if (!form) {
    return (
      <div className="card">
        <div className="empty-state">Carregando…</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Configurações</h2>
          <p>O mesmo arquivo que a CLI lê e escreve — a maioria dos campos vale imediatamente, sem reiniciar o app.</p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="btn" onClick={restoreDefaults}>
            Restaurar padrões
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && !error && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
          Configuração salva.
        </div>
      )}

      <h3 className="section-title">Execução</h3>
      <div className="card" style={{ padding: 14, marginBottom: 24 }}>
        <Checkbox label="Rodar sem interface (headless) por padrão" checked={form.defaultHeadless} onChange={(v) => set('defaultHeadless', v)} />
        <Checkbox label="Gravar trace de execução" checked={form.captureTrace} onChange={(v) => set('captureTrace', v)} />
        <Checkbox
          label="Detectar parede de login (RF-046)"
          checked={form.detectLoginWall}
          onChange={(v) => set('detectLoginWall', v)}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 4 }}>
          <Field label="Timeout padrão por passo" hint="ms">
            <NumberInput value={form.defaultTimeoutMs} onChange={(v) => set('defaultTimeoutMs', v)} />
          </Field>
          <Field label="Tentativas por passo">
            <NumberInput value={form.defaultMaxRetries} onChange={(v) => set('defaultMaxRetries', v)} width={60} />
          </Field>
          <Field label="Viewport padrão" hint="largura × altura">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              <NumberInput value={form.viewportWidth} onChange={(v) => set('viewportWidth', v)} width={70} />
              <span className="text-muted">×</span>
              <NumberInput value={form.viewportHeight} onChange={(v) => set('viewportHeight', v)} width={70} />
            </div>
          </Field>
          <Field label="Atraso entre passos" hint="ms, faixa min–max, RN-008">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              <NumberInput value={form.stepDelayMin} onChange={(v) => set('stepDelayMin', v)} width={70} />
              <span className="text-muted">–</span>
              <NumberInput value={form.stepDelayMax} onChange={(v) => set('stepDelayMax', v)} width={70} />
            </div>
          </Field>
        </div>
      </div>

      <h3 className="section-title">Retenção de artefatos</h3>
      <div className="card" style={{ padding: 14, marginBottom: 24 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <Field label="Idade máxima" hint="dias">
            <NumberInput value={form.maxAgeDays} onChange={(v) => set('maxAgeDays', v)} width={70} />
          </Field>
          <Field label="Máximo de execuções retidas">
            <NumberInput value={form.maxRuns} onChange={(v) => set('maxRuns', v)} width={70} />
          </Field>
          <Field label="Multiplicador para falhas/bloqueios" hint="RN-011">
            <NumberInput value={form.failureMultiplier} onChange={(v) => set('failureMultiplier', v)} width={60} />
          </Field>
          <Field label="Aviso de disco" hint="MB">
            <NumberInput value={form.diskWarningMb} onChange={(v) => set('diskWarningMb', v)} width={90} />
          </Field>
        </div>
      </div>

      <h3 className="section-title">Fila e navegadores</h3>
      <p className="text-muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
        Estes quatro campos ficam presos dentro da fila e do pool de navegadores assim que o app inicia — salvar aqui grava no arquivo
        normalmente, mas só valem de fato depois de fechar e abrir o Maestro de novo.
      </p>
      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <Field label="Navegadores simultâneos" hint="RF-051">
            <NumberInput value={form.maxConcurrentBrowsers} onChange={(v) => set('maxConcurrentBrowsers', v)} width={60} />
          </Field>
          <Field label="Timeout máximo por job" hint="ms, RNF-014">
            <NumberInput value={form.jobTimeoutMs} onChange={(v) => set('jobTimeoutMs', v)} />
          </Field>
          <Field label="Atraso entre jobs do mesmo perfil" hint="ms, faixa min–max, RN-008">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              <NumberInput value={form.jobDelayMin} onChange={(v) => set('jobDelayMin', v)} width={70} />
              <span className="text-muted">–</span>
              <NumberInput value={form.jobDelayMax} onChange={(v) => set('jobDelayMax', v)} width={70} />
            </div>
          </Field>
          <Field label="Ociosidade antes de fechar navegador reaproveitado" hint="ms, RF-055">
            <NumberInput value={form.browserIdleTtlMs} onChange={(v) => set('browserIdleTtlMs', v)} />
          </Field>
        </div>
      </div>
    </div>
  );
}
