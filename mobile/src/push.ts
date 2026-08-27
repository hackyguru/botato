/**
 * Telling the laptop where to reach this phone when the app is not running.
 *
 * iOS will only wake a closed app for a notification that came through Apple's
 * push service — there is no way for a laptop on the same network to do it
 * directly, and no socket survives the app being suspended. So the laptop
 * talks to Apple itself: it holds a key, signs a request, and hands Apple a
 * device token. Nothing else sits in between, which is the whole reason not to
 * use a push relay somebody else runs.
 *
 * The token is what this file is for. It is issued by iOS to this install of
 * this app, it is useless to anyone without the key, and it changes — on
 * reinstall, on restore to a new phone — so it is sent every launch rather
 * than once and remembered.
 *
 * The native token, not Expo's. Expo's would route through Expo's servers,
 * which is exactly the middle this design does not want.
 */

import * as Device from "expo-device";
import { Platform } from "react-native";

/** Whether there is any point reaching for the notifications module.
 *
 *  A simulator has no push service to register with, and a build made before
 *  push existed has this file's JavaScript without the native half of it —
 *  touching the module there takes the whole app down at launch, which is
 *  exactly what a dev build one rebuild behind did. Both are the same answer:
 *  this install cannot be reached, so do not go looking.
 *
 *  A `try` around the import is not enough. The module throws while it is
 *  being set up, from inside its own promise, and the failure arrives as an
 *  unhandled error rather than as something a catch here could hold. */
const reachable = Device.isDevice && Platform.OS === "ios";

function notifications(): typeof import("expo-notifications") | null {
  if (!reachable) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications");
  } catch {
    return null;
  }
}

/** What the laptop needs to reach this phone. */
export interface PushWhere {
  /** The APNs device token, as hex. */
  token: string;
  /** Which of Apple's two push services issued it. A token from a development
   *  build is refused by the production host and the other way round, and the
   *  error Apple returns for the mismatch says nothing useful — so the phone
   *  says which one it is rather than leaving the laptop to guess. */
  sandbox: boolean;
  /** So the laptop can name the device in its own settings. */
  name: string;
}

/** Ask for permission and read the token, or say why not.
 *
 *  Refusal is a normal answer and not an error: somebody who says no to
 *  notifications has said something, and asking again on every launch is how
 *  an app teaches people to say no faster.
 */
export async function pushWhere(): Promise<PushWhere | null> {
  const Notifications = notifications();
  if (!Notifications) return null;

  const has = await Notifications.getPermissionsAsync();
  const granted =
    has.granted ||
    (has.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
  if (!granted) return null;

  try {
    const got = await Notifications.getDevicePushTokenAsync();
    return {
      token: String(got.data),
      // A build installed from Xcode or from `expo run:ios` carries the
      // development entitlement, which is the sandbox service.
      sandbox: __DEV__ || true,
      name: Device.deviceName ?? "an iPhone",
    };
  } catch {
    // No entitlement, no network, no provisioning profile: all of them mean
    // the same thing here, which is that this build cannot be reached.
    return null;
  }
}

/** What to do with one that arrives while the app is open.
 *
 *  Shown rather than swallowed: the alternative is a phone that stays silent
 *  because the app happens to be in front of you, which is only correct if you
 *  are looking at the conversation it is about — and it usually is not.
 */
export function showThemWhileOpen(): void {
  const Notifications = notifications();
  if (!Notifications) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}
