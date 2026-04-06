import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

class EmailNotVerifiedError extends CredentialsSignin {
  code = "EMAIL_NOT_VERIFIED";
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "MEMBER" | "ADMIN";
      forcePasswordChange: boolean;
      isEmailVerified: boolean;
    };
  }
  interface User {
    role: "MEMBER" | "ADMIN";
    forcePasswordChange: boolean;
    isEmailVerified: boolean;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
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

        // Only primary accounts (not dependents) can log in
        const member = await prisma.member.findFirst({
          where: { email: email.toLowerCase(), parentMemberId: null },
        });

        if (!member || !member.active) {
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
      }
      return token;
    },
    async session({ session, token }) {
      session.user.role = token.role as "MEMBER" | "ADMIN";
      session.user.id = token.id as string;
      session.user.forcePasswordChange = token.forcePasswordChange as boolean;
      session.user.isEmailVerified = token.isEmailVerified as boolean;
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
});
