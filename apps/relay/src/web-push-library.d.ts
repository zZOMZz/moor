declare module 'web-push' {
  const webPush: {
    generateRequestDetails(
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
      payload: string,
      options: {
        TTL: number;
        urgency: 'normal' | 'high';
        contentEncoding: 'aes128gcm';
        vapidDetails: { subject: string; publicKey: string; privateKey: string };
      },
    ): { endpoint: string; method: string; headers: Record<string, string | number>; body: Buffer };
  };
  export default webPush;
}
