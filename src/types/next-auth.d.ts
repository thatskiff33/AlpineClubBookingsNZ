import "next-auth";

declare module "next-auth" {
  interface User {
    id: string;
    role: string;
    forcePasswordChange: boolean;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      forcePasswordChange: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: string;
    forcePasswordChange: boolean;
  }
}
