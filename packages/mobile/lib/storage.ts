import * as SecureStore from "expo-secure-store";

const KEYS = {
  KALSHI_EMAIL: "kalshi_email",
  KALSHI_PASSWORD: "kalshi_password",
  AUTO_TRADE: "auto_trade_enabled",
};

export async function saveCredentials(email: string, password: string) {
  await SecureStore.setItemAsync(KEYS.KALSHI_EMAIL, email);
  await SecureStore.setItemAsync(KEYS.KALSHI_PASSWORD, password);
}

export async function loadCredentials(): Promise<{ email: string; password: string }> {
  const email = (await SecureStore.getItemAsync(KEYS.KALSHI_EMAIL)) || "";
  const password = (await SecureStore.getItemAsync(KEYS.KALSHI_PASSWORD)) || "";
  return { email, password };
}

export async function clearCredentials() {
  await SecureStore.deleteItemAsync(KEYS.KALSHI_EMAIL);
  await SecureStore.deleteItemAsync(KEYS.KALSHI_PASSWORD);
}

export async function setAutoTrade(enabled: boolean) {
  await SecureStore.setItemAsync(KEYS.AUTO_TRADE, enabled ? "1" : "0");
}

export async function getAutoTrade(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(KEYS.AUTO_TRADE);
  return val === "1";
}
