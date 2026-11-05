import { initTelemetry } from './telemetry.js';

await initTelemetry();
const { loadConfig } = await import('./config.js');
const { createApp } = await import('./app.js');

const config = loadConfig();
const app = await createApp(config);
app.listen(config.port, () => console.log(`bangji web listening on :${config.port}`));
