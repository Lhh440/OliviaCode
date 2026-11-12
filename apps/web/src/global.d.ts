export {};

declare global {
  interface Window {
    olivia?: {
      version: string;
      platform: string;
      desktop: boolean;
      env: { baseUrl: string; apiKey: string; model: string };
    };
  }
}
