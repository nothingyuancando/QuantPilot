import { Button } from '@/components/ui/button';
import type { CLIStatusEntry } from '@/types/cli';
import { modelAvailabilityError } from '@/lib/utils/cliOptions';

export function ModelReadinessNotice({ status, model, onRefresh, onSettings }: {
  status: CLIStatusEntry | undefined;
  model: string;
  onRefresh: () => void;
  onSettings: () => void;
}) {
  const message = modelAvailabilityError(status, model);
  if (!message) return null;
  return (
    <div id="model-readiness-notice" tabIndex={-1} role="status" aria-live="polite" className="mb-3 flex scroll-mt-20 flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs focus:outline-none">
      <p className="min-w-0 flex-1 basis-60 break-words">{message} 研究问题会保留。</p>
      <Button type="button" variant="outline" size="sm" disabled={status?.checking} onClick={onRefresh}>重新检查模型</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onSettings}>模型设置</Button>
    </div>
  );
}
