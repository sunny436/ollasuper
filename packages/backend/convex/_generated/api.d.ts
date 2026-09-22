/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ResendOTP from "../ResendOTP.js";
import type * as accountState from "../accountState.js";
import type * as apiKeys from "../apiKeys.js";
import type * as audit from "../audit.js";
import type * as auditLog from "../auditLog.js";
import type * as auth from "../auth.js";
import type * as authCodes from "../authCodes.js";
import type * as authDeletion from "../authDeletion.js";
import type * as authEvents from "../authEvents.js";
import type * as authEventsPurge from "../authEventsPurge.js";
import type * as authPassword from "../authPassword.js";
import type * as authPolicy from "../authPolicy.js";
import type * as authProbe from "../authProbe.js";
import type * as authPurge from "../authPurge.js";
import type * as authReconcile from "../authReconcile.js";
import type * as authSessions from "../authSessions.js";
import type * as backend from "../backend.js";
import type * as blobSafety from "../blobSafety.js";
import type * as chat_approvals from "../chat/approvals.js";
import type * as chat_artifacts from "../chat/artifacts.js";
import type * as chat_attachments from "../chat/attachments.js";
import type * as chat_authz from "../chat/authz.js";
import type * as chat_capabilities from "../chat/capabilities.js";
import type * as chat_context from "../chat/context.js";
import type * as chat_events from "../chat/events.js";
import type * as chat_executions from "../chat/executions.js";
import type * as chat_ingest from "../chat/ingest.js";
import type * as chat_ingress from "../chat/ingress.js";
import type * as chat_messages from "../chat/messages.js";
import type * as chat_models from "../chat/models.js";
import type * as chat_public from "../chat/public.js";
import type * as chat_search from "../chat/search.js";
import type * as chat_settings from "../chat/settings.js";
import type * as chat_shares from "../chat/shares.js";
import type * as chat_stream from "../chat/stream.js";
import type * as chat_threads from "../chat/threads.js";
import type * as chat_title from "../chat/title.js";
import type * as counters from "../counters.js";
import type * as crons from "../crons.js";
import type * as devGuard from "../devGuard.js";
import type * as email_index from "../email/index.js";
import type * as email_templates_subscriptionEmail from "../email/templates/subscriptionEmail.js";
import type * as email from "../email.js";
import type * as emailTemplates from "../emailTemplates.js";
import type * as env from "../env.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as init from "../init.js";
import type * as mailSubject from "../mailSubject.js";
import type * as mcp_audit from "../mcp/audit.js";
import type * as mcp_capabilities from "../mcp/capabilities.js";
import type * as mcp_catalogue from "../mcp/catalogue.js";
import type * as mcp_connections from "../mcp/connections.js";
import type * as mcp_credentials from "../mcp/credentials.js";
import type * as mcp_limits from "../mcp/limits.js";
import type * as mcp_oauth from "../mcp/oauth.js";
import type * as mcp_text from "../mcp/text.js";
import type * as memories from "../memories.js";
import type * as memoryUtil from "../memoryUtil.js";
import type * as notifications from "../notifications.js";
import type * as ollastack from "../ollastack.js";
import type * as orgs from "../orgs.js";
import type * as passwordProvider from "../passwordProvider.js";
import type * as passwordProviders from "../passwordProviders.js";
import type * as projects from "../projects.js";
import type * as quotas from "../quotas.js";
import type * as reportMarkdown from "../reportMarkdown.js";
import type * as researchRuns from "../researchRuns.js";
import type * as scheduled_authz from "../scheduled/authz.js";
import type * as scheduled_delivery from "../scheduled/delivery.js";
import type * as scheduled_execution from "../scheduled/execution.js";
import type * as scheduled_occurrences from "../scheduled/occurrences.js";
import type * as scheduled_parse from "../scheduled/parse.js";
import type * as scheduled_schedule from "../scheduled/schedule.js";
import type * as scheduled_tasks from "../scheduled/tasks.js";
import type * as seed from "../seed.js";
import type * as skillCapabilities from "../skillCapabilities.js";
import type * as skillPolicy from "../skillPolicy.js";
import type * as seoMutations from "../seoMutations.js";
import type * as subscriptions from "../subscriptions.js";
import type * as urlGuard from "../urlGuard.js";
import type * as usage from "../usage.js";
import type * as userFiles from "../userFiles.js";
import type * as userSkills from "../userSkills.js";
import type * as users from "../users.js";
import type * as utils_validators from "../utils/validators.js";
import type * as web from "../web.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  ResendOTP: typeof ResendOTP;
  accountState: typeof accountState;
  apiKeys: typeof apiKeys;
  audit: typeof audit;
  auditLog: typeof auditLog;
  auth: typeof auth;
  authCodes: typeof authCodes;
  authDeletion: typeof authDeletion;
  authEvents: typeof authEvents;
  authEventsPurge: typeof authEventsPurge;
  authPassword: typeof authPassword;
  authPolicy: typeof authPolicy;
  authProbe: typeof authProbe;
  authPurge: typeof authPurge;
  authReconcile: typeof authReconcile;
  authSessions: typeof authSessions;
  backend: typeof backend;
  blobSafety: typeof blobSafety;
  "chat/approvals": typeof chat_approvals;
  "chat/artifacts": typeof chat_artifacts;
  "chat/attachments": typeof chat_attachments;
  "chat/authz": typeof chat_authz;
  "chat/capabilities": typeof chat_capabilities;
  "chat/context": typeof chat_context;
  "chat/events": typeof chat_events;
  "chat/executions": typeof chat_executions;
  "chat/ingest": typeof chat_ingest;
  "chat/ingress": typeof chat_ingress;
  "chat/messages": typeof chat_messages;
  "chat/models": typeof chat_models;
  "chat/public": typeof chat_public;
  "chat/search": typeof chat_search;
  "chat/settings": typeof chat_settings;
  "chat/shares": typeof chat_shares;
  "chat/stream": typeof chat_stream;
  "chat/threads": typeof chat_threads;
  "chat/title": typeof chat_title;
  counters: typeof counters;
  crons: typeof crons;
  devGuard: typeof devGuard;
  "email/index": typeof email_index;
  "email/templates/subscriptionEmail": typeof email_templates_subscriptionEmail;
  email: typeof email;
  emailTemplates: typeof emailTemplates;
  env: typeof env;
  files: typeof files;
  http: typeof http;
  init: typeof init;
  mailSubject: typeof mailSubject;
  "mcp/audit": typeof mcp_audit;
  "mcp/capabilities": typeof mcp_capabilities;
  "mcp/catalogue": typeof mcp_catalogue;
  "mcp/connections": typeof mcp_connections;
  "mcp/credentials": typeof mcp_credentials;
  "mcp/limits": typeof mcp_limits;
  "mcp/oauth": typeof mcp_oauth;
  "mcp/text": typeof mcp_text;
  memories: typeof memories;
  memoryUtil: typeof memoryUtil;
  notifications: typeof notifications;
  ollastack: typeof ollastack;
  orgs: typeof orgs;
  passwordProvider: typeof passwordProvider;
  passwordProviders: typeof passwordProviders;
  projects: typeof projects;
  quotas: typeof quotas;
  reportMarkdown: typeof reportMarkdown;
  researchRuns: typeof researchRuns;
  "scheduled/authz": typeof scheduled_authz;
  "scheduled/delivery": typeof scheduled_delivery;
  "scheduled/execution": typeof scheduled_execution;
  "scheduled/occurrences": typeof scheduled_occurrences;
  "scheduled/parse": typeof scheduled_parse;
  "scheduled/schedule": typeof scheduled_schedule;
  "scheduled/tasks": typeof scheduled_tasks;
  seed: typeof seed;
  seoMutations: typeof seoMutations;
  skillCapabilities: typeof skillCapabilities;
  skillPolicy: typeof skillPolicy;
  subscriptions: typeof subscriptions;
  urlGuard: typeof urlGuard;
  usage: typeof usage;
  userFiles: typeof userFiles;
  userSkills: typeof userSkills;
  users: typeof users;
  "utils/validators": typeof utils_validators;
  web: typeof web;
}>;
declare const fullApiWithMounts: typeof fullApi;

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

export declare const components: {
  polar: {
    lib: {
      createProduct: FunctionReference<
        "mutation",
        "internal",
        {
          product: {
            createdAt: string;
            description: string | null;
            id: string;
            isArchived: boolean;
            isRecurring: boolean;
            medias: Array<{
              checksumEtag: string | null;
              checksumSha256Base64: string | null;
              checksumSha256Hex: string | null;
              createdAt: string;
              id: string;
              isUploaded: boolean;
              lastModifiedAt: string | null;
              mimeType: string;
              name: string;
              organizationId: string;
              path: string;
              publicUrl: string;
              service?: string;
              size: number;
              sizeReadable: string;
              storageVersion: string | null;
              version: string | null;
            }>;
            modifiedAt: string | null;
            name: string;
            organizationId: string;
            prices: Array<{
              amountType?: string;
              createdAt: string;
              id: string;
              isArchived: boolean;
              modifiedAt: string | null;
              priceAmount?: number;
              priceCurrency?: string;
              productId: string;
              recurringInterval?: "month" | "year" | null;
              type?: string;
            }>;
            recurringInterval?: "month" | "year" | null;
          };
        },
        any
      >;
      createSubscription: FunctionReference<
        "mutation",
        "internal",
        {
          subscription: {
            amount: number | null;
            cancelAtPeriodEnd: boolean;
            checkoutId: string | null;
            createdAt: string;
            currency: string | null;
            currentPeriodEnd: string | null;
            currentPeriodStart: string;
            customerId: string;
            endedAt: string | null;
            id: string;
            metadata: Record<string, any>;
            modifiedAt: string | null;
            priceId: string;
            productId: string;
            recurringInterval: "month" | "year" | null;
            startedAt: string | null;
            status: string;
          };
        },
        any
      >;
      getCurrentSubscription: FunctionReference<
        "query",
        "internal",
        { userId: string },
        {
          amount: number | null;
          cancelAtPeriodEnd: boolean;
          checkoutId: string | null;
          createdAt: string;
          currency: string | null;
          currentPeriodEnd: string | null;
          currentPeriodStart: string;
          customerId: string;
          endedAt: string | null;
          id: string;
          metadata: Record<string, any>;
          modifiedAt: string | null;
          priceId: string;
          product: {
            createdAt: string;
            description: string | null;
            id: string;
            isArchived: boolean;
            isRecurring: boolean;
            medias: Array<{
              checksumEtag: string | null;
              checksumSha256Base64: string | null;
              checksumSha256Hex: string | null;
              createdAt: string;
              id: string;
              isUploaded: boolean;
              lastModifiedAt: string | null;
              mimeType: string;
              name: string;
              organizationId: string;
              path: string;
              publicUrl: string;
              service?: string;
              size: number;
              sizeReadable: string;
              storageVersion: string | null;
              version: string | null;
            }>;
            modifiedAt: string | null;
            name: string;
            organizationId: string;
            prices: Array<{
              amountType?: string;
              createdAt: string;
              id: string;
              isArchived: boolean;
              modifiedAt: string | null;
              priceAmount?: number;
              priceCurrency?: string;
              productId: string;
              recurringInterval?: "month" | "year" | null;
              type?: string;
            }>;
            recurringInterval?: "month" | "year" | null;
          };
          productId: string;
          recurringInterval: "month" | "year" | null;
          startedAt: string | null;
          status: string;
        } | null
      >;
      getCustomerByUserId: FunctionReference<
        "query",
        "internal",
        { userId: string },
        { id: string; userId: string } | null
      >;
      getProduct: FunctionReference<
        "query",
        "internal",
        { id: string },
        {
          createdAt: string;
          description: string | null;
          id: string;
          isArchived: boolean;
          isRecurring: boolean;
          medias: Array<{
            checksumEtag: string | null;
            checksumSha256Base64: string | null;
            checksumSha256Hex: string | null;
            createdAt: string;
            id: string;
            isUploaded: boolean;
            lastModifiedAt: string | null;
            mimeType: string;
            name: string;
            organizationId: string;
            path: string;
            publicUrl: string;
            service?: string;
            size: number;
            sizeReadable: string;
            storageVersion: string | null;
            version: string | null;
          }>;
          modifiedAt: string | null;
          name: string;
          organizationId: string;
          prices: Array<{
            amountType?: string;
            createdAt: string;
            id: string;
            isArchived: boolean;
            modifiedAt: string | null;
            priceAmount?: number;
            priceCurrency?: string;
            productId: string;
            recurringInterval?: "month" | "year" | null;
            type?: string;
          }>;
          recurringInterval?: "month" | "year" | null;
        } | null
      >;
      getSubscription: FunctionReference<
        "query",
        "internal",
        { id: string },
        {
          amount: number | null;
          cancelAtPeriodEnd: boolean;
          checkoutId: string | null;
          createdAt: string;
          currency: string | null;
          currentPeriodEnd: string | null;
          currentPeriodStart: string;
          customerId: string;
          endedAt: string | null;
          id: string;
          metadata: Record<string, any>;
          modifiedAt: string | null;
          priceId: string;
          productId: string;
          recurringInterval: "month" | "year" | null;
          startedAt: string | null;
          status: string;
        } | null
      >;
      insertCustomer: FunctionReference<
        "mutation",
        "internal",
        { id: string; userId: string },
        string
      >;
      listCustomerSubscriptions: FunctionReference<
        "query",
        "internal",
        { customerId: string },
        Array<{
          amount: number | null;
          cancelAtPeriodEnd: boolean;
          checkoutId: string | null;
          createdAt: string;
          currency: string | null;
          currentPeriodEnd: string | null;
          currentPeriodStart: string;
          customerId: string;
          endedAt: string | null;
          id: string;
          metadata: Record<string, any>;
          modifiedAt: string | null;
          priceId: string;
          productId: string;
          recurringInterval: "month" | "year" | null;
          startedAt: string | null;
          status: string;
        }>
      >;
      listProducts: FunctionReference<
        "query",
        "internal",
        { includeArchived?: boolean },
        Array<{
          createdAt: string;
          description: string | null;
          id: string;
          isArchived: boolean;
          isRecurring: boolean;
          medias: Array<{
            checksumEtag: string | null;
            checksumSha256Base64: string | null;
            checksumSha256Hex: string | null;
            createdAt: string;
            id: string;
            isUploaded: boolean;
            lastModifiedAt: string | null;
            mimeType: string;
            name: string;
            organizationId: string;
            path: string;
            publicUrl: string;
            service?: string;
            size: number;
            sizeReadable: string;
            storageVersion: string | null;
            version: string | null;
          }>;
          modifiedAt: string | null;
          name: string;
          organizationId: string;
          priceAmount?: number;
          prices: Array<{
            amountType?: string;
            createdAt: string;
            id: string;
            isArchived: boolean;
            modifiedAt: string | null;
            priceAmount?: number;
            priceCurrency?: string;
            productId: string;
            recurringInterval?: "month" | "year" | null;
            type?: string;
          }>;
          recurringInterval?: "month" | "year" | null;
        }>
      >;
      listUserSubscriptions: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          amount: number | null;
          cancelAtPeriodEnd: boolean;
          checkoutId: string | null;
          createdAt: string;
          currency: string | null;
          currentPeriodEnd: string | null;
          currentPeriodStart: string;
          customerId: string;
          endedAt: string | null;
          id: string;
          metadata: Record<string, any>;
          modifiedAt: string | null;
          priceId: string;
          product: {
            createdAt: string;
            description: string | null;
            id: string;
            isArchived: boolean;
            isRecurring: boolean;
            medias: Array<{
              checksumEtag: string | null;
              checksumSha256Base64: string | null;
              checksumSha256Hex: string | null;
              createdAt: string;
              id: string;
              isUploaded: boolean;
              lastModifiedAt: string | null;
              mimeType: string;
              name: string;
              organizationId: string;
              path: string;
              publicUrl: string;
              service?: string;
              size: number;
              sizeReadable: string;
              storageVersion: string | null;
              version: string | null;
            }>;
            modifiedAt: string | null;
            name: string;
            organizationId: string;
            prices: Array<{
              amountType?: string;
              createdAt: string;
              id: string;
              isArchived: boolean;
              modifiedAt: string | null;
              priceAmount?: number;
              priceCurrency?: string;
              productId: string;
              recurringInterval?: "month" | "year" | null;
              type?: string;
            }>;
            recurringInterval?: "month" | "year" | null;
          } | null;
          productId: string;
          recurringInterval: "month" | "year" | null;
          startedAt: string | null;
          status: string;
        }>
      >;
      updateProduct: FunctionReference<
        "mutation",
        "internal",
        {
          product: {
            createdAt: string;
            description: string | null;
            id: string;
            isArchived: boolean;
            isRecurring: boolean;
            medias: Array<{
              checksumEtag: string | null;
              checksumSha256Base64: string | null;
              checksumSha256Hex: string | null;
              createdAt: string;
              id: string;
              isUploaded: boolean;
              lastModifiedAt: string | null;
              mimeType: string;
              name: string;
              organizationId: string;
              path: string;
              publicUrl: string;
              service?: string;
              size: number;
              sizeReadable: string;
              storageVersion: string | null;
              version: string | null;
            }>;
            modifiedAt: string | null;
            name: string;
            organizationId: string;
            prices: Array<{
              amountType?: string;
              createdAt: string;
              id: string;
              isArchived: boolean;
              modifiedAt: string | null;
              priceAmount?: number;
              priceCurrency?: string;
              productId: string;
              recurringInterval?: "month" | "year" | null;
              type?: string;
            }>;
            recurringInterval?: "month" | "year" | null;
          };
        },
        any
      >;
      updateSubscription: FunctionReference<
        "mutation",
        "internal",
        {
          subscription: {
            amount: number | null;
            cancelAtPeriodEnd: boolean;
            checkoutId: string | null;
            createdAt: string;
            currency: string | null;
            currentPeriodEnd: string | null;
            currentPeriodStart: string;
            customerId: string;
            endedAt: string | null;
            id: string;
            metadata: Record<string, any>;
            modifiedAt: string | null;
            priceId: string;
            productId: string;
            recurringInterval: "month" | "year" | null;
            startedAt: string | null;
            status: string;
          };
        },
        any
      >;
      upsertCustomer: FunctionReference<
        "mutation",
        "internal",
        { customerId: string; userId: string },
        string
      >;
    };
  };
};
