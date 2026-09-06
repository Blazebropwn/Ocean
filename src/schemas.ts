import { z } from "zod";

export const registerSchema = z.object({
  email: z.email("Zadejte platný e-mail.").max(254).transform((v) => v.trim().toLowerCase()).optional(),
  username: z.string().trim().min(3, "Uživatelské jméno musí mít alespoň 3 znaky.").max(32, "Uživatelské jméno může mít nejvýše 32 znaků.").regex(/^[a-zA-Z0-9_]+$/, "Použijte pouze písmena, čísla a podtržítko."),
  password: z.string().min(8, "Heslo musí mít alespoň 8 znaků.").max(128),
  confirmation: z.string().min(8).max(128).optional(),
  inviteToken: z.string().min(32).max(128).optional(),
}).refine((data) => data.confirmation === undefined || data.password === data.confirmation, {
  message: "Hesla se neshodují.",
  path: ["confirmation"],
});

export const invitationCreateSchema = z.object({
  email: z.union([z.literal(""), z.email("Zadejte platný e-mail.").max(254)]).optional().transform((value) => value?.trim().toLowerCase() || null),
});

export const loginSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1).max(128),
});

export const recoveryRequestSchema = z.object({
  email: z.email().max(254).transform((v) => v.trim().toLowerCase()),
});

export const recoveryConfirmSchema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(8, "Heslo musí mít alespoň 8 znaků.").max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8, "Nové heslo musí mít alespoň 8 znaků.").max(128),
});

export const kryptotronControlSchema = z.object({
  entriesPaused: z.boolean(),
});

export const dcaControlSchema = z.object({
  enabled: z.boolean(),
});

export const dcaAmountSchema = z.object({
  amount: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(50), z.literal(100), z.literal(200), z.literal(500), z.literal(1000)]),
});

export const streakControlSchema = z.object({
  enabled: z.boolean(),
});

export const binanceConnectionSchema = z.object({
  apiKey: z.string().trim().min(16).max(256),
  apiSecret: z.string().trim().min(16).max(256),
  environment: z.enum(["testnet", "mainnet"]),
  withdrawalsDisabledConfirmed: z.literal(true),
});
