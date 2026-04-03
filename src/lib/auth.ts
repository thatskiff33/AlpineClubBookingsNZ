import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "MEMBER" | "ADMIN";
    };
  }
  interface User {
    role: "MEMBER" | "ADMIN";
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

        const member = await prisma.member.findUnique({
          where: { email: email.toLowerCase() },
        });

        if (!member || !member.active) {
          return null;
        }

        const isValid = await bcrypt.compare(password, member.passwordHash);
        if (!isValid) {
          return null;
        }

        return {
          id: member.id,
          email: member.email,
          name: `${member.firstName} ${member.lastName}`,
          role: member.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.id = user.id as string;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.role = token.role as "MEMBER" | "ADMIN";
      session.user.id = token.id as string;
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
