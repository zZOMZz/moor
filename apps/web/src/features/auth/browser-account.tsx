import { useEffect, useRef, useState } from 'react';
import { api, type Identity } from '../../platform/api';
import { NotificationController } from '../notifications/notifications';
import { NotificationPanel } from '../notifications/notification-ui';
import {
  notificationBrowser,
  browserNotificationReason,
} from '../notifications/notification-browser';
import { GoogleAccount } from './google-login';

export function BrowserAccountControls({
  owner,
  identity,
}: {
  owner: string;
  identity: () => Promise<Identity>;
}) {
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [google, setGoogle] = useState<Identity>();
  const [error, setError] = useState('');
  const [, render] = useState(0);
  const active = useRef(true);
  const controller = useRef<NotificationController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = (action: () => Promise<unknown> | undefined) => {
    const failed = (reason: unknown) => {
      if (active.current) setError(reason instanceof Error ? reason.message : '账号操作未完成。');
    };
    setError('');
    try {
      void action()?.catch(failed);
    } catch (reason) {
      failed(reason);
    }
  };
  return (
    <>
      <button
        onClick={() => {
          controller.current ??= new NotificationController(owner, {
            browser: notificationBrowser,
            request: api,
            current: () => active.current,
            changed: () => {
              if (active.current) render((value) => value + 1);
            },
          });
          setNotificationsOpen(true);
          run(() => controller.current?.refresh());
        }}
      >
        通知设置
      </button>
      <button
        onClick={() =>
          run(() =>
            identity().then((value) => {
              if (value.owner === owner) setGoogle(value);
            }),
          )
        }
      >
        Google 登录设置
      </button>
      <a href="/?collaboration=1">共享任务</a>
      {error && <p role="alert">{error}</p>}
      {google && (
        <GoogleAccount
          identity={google}
          onClose={() => setGoogle(undefined)}
          onRefresh={async () => {
            const value = await identity();
            if (value.owner === owner) setGoogle(value);
          }}
        />
      )}
      {notificationsOpen && (
        <NotificationPanel
          controller={controller.current}
          reason={browserNotificationReason()}
          onClose={() => setNotificationsOpen(false)}
          onRefresh={() => {
            void controller.current?.refresh();
          }}
          onEnable={(preferences) => {
            run(() => controller.current?.enable(preferences));
          }}
          onPreferences={(preferences) => {
            void controller.current?.savePreferences(preferences);
          }}
          onDisable={(record) => {
            void controller.current?.disable(record);
          }}
        />
      )}
    </>
  );
}
