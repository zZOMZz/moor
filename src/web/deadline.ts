export function deadline<T>(
  work: Promise<T>,
  ms: number,
  message: string,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = schedule(() => reject(new Error(message)), ms);
    work.then(resolve, reject).finally(() => cancel(timer));
  });
}
