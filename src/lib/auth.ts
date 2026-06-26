import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { getAuthSecret, getAuthTrustHost } from "./runtime-config";
import logger from "./logger";

class EmailNotVerifiedError extends CredentialsSignin {
  code = "EMAIL_NOT_VERIFIED";
}

// bcrypt hash of a random throwaway value. Compared against when no member
// matches the email so unknown and known accounts take the same time,
// preventing account enumeration via response timing.
const DUMMY_PASSWORD_HASH =
  "$2b$12$vgnj5fAMZNzi.jYdELu0f.rjCvFqb/tgzYxtvBWJu8vCJYVO64SKC";

const SESSION_MEMBER_SECURITY_SELECT = {
  role: true,
  forcePasswordChange: true,
  emailVerified: true,
  passwordChangedAt: true,
} as const;

async function loadSessionMemberSecurity(userId: string) {
  return prisma.member.findUnique({
    where: { id: userId },
    select: SESSION_MEMBER_SECURITY_SELECT,
  });
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "MEMBER" | "ADMIN" | "LODGE" | "ASSOCIATE" | "LIFE";
      forcePasswordChange: boolean;
      isEmailVerified: boolean;
      sessionInvalidated?: boolean;
    };
  }
  interface User {
    role: "MEMBER" | "ADMIN" | "LODGE" | "ASSOCIATE" | "LIFE";
    forcePasswordChange: boolean;
    isEmailVerified: boolean;
  }
}

function getTokenSessionIssuedAtMs(token: {
  sessionIssuedAt?: unknown;
  iat?: unknown;
}) {
  if (
    typeof token.sessionIssuedAt === "number" &&
    Number.isFinite(token.sessionIssuedAt)
  ) {
    return token.sessionIssuedAt;
  }

  if (typeof token.iat === "number" && Number.isFinite(token.iat)) {
    return token.iat * 1000;
  }

  return Date.now();
}

export const authConfig = {
  trustHost: getAuthTrustHost(),
  secret: getAuthSecret(),
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Only members with canLogin=true (adults with unique email + password) can log in
        const member = await prisma.member.findFirst({
          where: { email: email.toLowerCase(), canLogin: true },
        });

        if (!member || !member.active) {
          await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
          return null;
        }

        const isValid = await bcrypt.compare(password, member.passwordHash);
        if (!isValid) {
          return null;
        }

        // Block unverified members from creating a session
        if (!member.emailVerified) {
          throw new EmailNotVerifiedError();
        }

        try {
          await prisma.member.update({
            where: { id: member.id },
            data: { lastLoginAt: new Date() },
          });
        } catch (error) {
          logger.warn(
            { err: error, memberId: member.id },
            "Failed to update member last login timestamp"
          );
        }

        return {
          id: member.id,
          email: member.email,
          name: `${member.firstName} ${member.lastName}`,
          role: member.role,
          forcePasswordChange: member.forcePasswordChange,
          isEmailVerified: member.emailVerified,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.id = user.id as string;
        token.forcePasswordChange = user.forcePasswordChange;
        token.isEmailVerified = user.isEmailVerified;
        token.sessionIssuedAt = Date.now();
        token.sessionInvalidated = false;
        // LODGE accounts get 30-day sessions for shared iPad kiosk
        if (user.role === "LODGE") {
          token.exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
        }
      }

      const sessionIssuedAt = getTokenSessionIssuedAtMs(token);
      token.sessionIssuedAt = sessionIssuedAt;

      if (typeof token.id === "string") {
        // Refresh security-sensitive session fields so role changes take effect
        // on the next request instead of waiting for JWT expiry.
        const member = await loadSessionMemberSecurity(token.id);

        if (member) {
          token.role = member.role;
          token.forcePasswordChange = member.forcePasswordChange;
          token.isEmailVerified = member.emailVerified;
          token.sessionInvalidated =
            member.passwordChangedAt instanceof Date &&
            member.passwordChangedAt.getTime() > sessionIssuedAt;
        }
      }

      return token;
    },
    async session({ session, token }) {
      session.user.role = token.role as "MEMBER" | "ADMIN" | "LODGE" | "ASSOCIATE" | "LIFE";
      session.user.id = token.id as string;
      session.user.forcePasswordChange = token.forcePasswordChange as boolean;
      session.user.isEmailVerified = token.isEmailVerified as boolean;
      session.user.sessionInvalidated = Boolean(token.sessionInvalidated);
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },
} satisfies NextAuthConfig;

const nextAuth = NextAuth(authConfig);

export const { handlers, signIn, signOut } = nextAuth;

export async function auth() {
  const session = await nextAuth.auth();

  if (session?.user?.sessionInvalidated) {
    return null;
  }

  return session;
}
