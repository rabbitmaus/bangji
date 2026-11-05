export async function initTelemetry(): Promise<void> {
  if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) return;
  try {
    const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
    useAzureMonitor();
  } catch (e) {
    console.warn('[telemetry] disabled:', (e as Error).message);
  }
}
