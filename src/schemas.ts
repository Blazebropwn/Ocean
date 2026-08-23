import { z } from "zod";

export const registerSchema = z.object({
  email: z.email("Zadejte platný e-mail.").max(254).transform((v) => v.trim().toLowerCase()),
  username: z.string().trim().min(3, "Uživatelské jméno musí mít alespoň 3 znaky.").max(32, "Uživatelské jméno může mít nejvýše 32 znaků.").regex(/^[a-zA-Z0-9_]+$/, "Použijte pouze písmena, čísla a podtržítko."),
  password: z.string().min(8, "Heslo musí mít alespoň 8 znaků.").max(128),
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
