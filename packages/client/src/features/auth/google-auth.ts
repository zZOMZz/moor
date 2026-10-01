export type GoogleMode = 'login' | 'setup' | 'link';
export type GoogleBegin = { mode: GoogleMode; setupToken?: string; password?: string };
export type GoogleReview = {
  flowId: string;
  mode: GoogleMode;
  desktop: boolean;
  code: string;
  email: string;
};
export interface GoogleAuthPort {
  begin(
    input: GoogleBegin,
    current: () => boolean,
  ): Promise<{ kind: 'confirmation'; code: string } | { kind: 'redirecting' }>;
  complete(current: () => boolean): Promise<{ completed: boolean }>;
  cancel(): Promise<void>;
  review(): Promise<GoogleReview>;
  confirm(flowId: string, desktop: boolean, current: () => boolean): Promise<void>;
  unlink(password: string): Promise<void>;
}
