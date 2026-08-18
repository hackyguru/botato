/**
 * Where the pairing token lives.
 *
 * On a phone that is the keychain or the Android keystore — the token is a
 * credential for someone's laptop and belongs nowhere else. expo-secure-store
 * has no web implementation, so running the same code in a browser throws from
 * inside pairing, which is how this was found; the browser gets localStorage
 * and says so rather than the app failing to connect at all.
 *
 * Failing to *persist* is also not the same as failing to pair. If the store is
 * unavailable the token still works for as long as the app is open, so these
 * never throw — the worst case is having to pair again next launch.
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const onWeb = Platform.OS === "web";

export async function getItem(key: string): Promise<string | null> {
  try {
    if (onWeb) return globalThis.localStorage?.getItem(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    if (onWeb) globalThis.localStorage?.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    /* in memory for this session is better than refusing to connect */
  }
}

export async function removeItem(key: string): Promise<void> {
  try {
    if (onWeb) globalThis.localStorage?.removeItem(key);
    else await SecureStore.deleteItemAsync(key);
  } catch {
    /* nothing to do — it is already unreachable */
  }
}

/** True where the token gets hardware-backed storage, for the pairing screen to
 *  be honest about what it is doing. */
export const isSecure = !onWeb;
