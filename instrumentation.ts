export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startRelaySourceSync } = await import('./lib/ai/relay-source-scheduler');
    startRelaySourceSync();
    const { startKiePriceSync } = await import('./lib/ai/kie-price-scheduler');
    startKiePriceSync();
    const { startNotificationScan } = await import('./lib/notifications/scheduler');
    startNotificationScan();
  }
}
