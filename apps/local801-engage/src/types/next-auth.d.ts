import "next-auth";
import "next-auth/jwt";

type Local801SessionState = {
  organizationSlug: string;
  userId: string;
  sessionVersion: number;
  mfaVerifiedAt: string;
};

declare module "next-auth" {
  interface Session {
    local801Auth?: Local801SessionState;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    local801Auth?: Local801SessionState;
  }
}
