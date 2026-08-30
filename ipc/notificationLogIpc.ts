import ctx from "./context";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "../services/logger";
import * as notificationLog from "../services/notificationLog";
import {
  NOTIFICATION_HISTORY_ADDED,
  NOTIFICATION_HISTORY_CLEAR,
  NOTIFICATION_HISTORY_GET,
} from "../config/shared/ipcChannels";
import type { NotificationKind } from "../config/shared/notifications";

const log = withScope("notificationLogIpc");

// Every caller is already on a notification path, so a failed write costs the
// history entry only and must never take the notification down with it.
export function recordNotification(kind: NotificationKind, title: string, body: string): void {
  try {
    const entry = notificationLog.record(kind, title, body);
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(NOTIFICATION_HISTORY_ADDED, entry);
  } catch (err) {
    log.warn("[Notifications] history record failed:", normalizeErrorMessage(err));
  }
}

function register(): void {
  handleAuthorized(NOTIFICATION_HISTORY_GET, assertMainRendererSender, () =>
    notificationLog.getAll(),
  );

  handleAuthorized(NOTIFICATION_HISTORY_CLEAR, assertMainRendererSender, () => {
    notificationLog.clear();
  });
}

export { register };
