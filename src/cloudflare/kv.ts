import type { AppConfig } from "../config.ts";
import type { AxiosCacheInstance } from "axios-cache-interceptor";
import { isAxiosError } from "axios";

export class CloudflareKv {
  private axios: AxiosCacheInstance;
  private readonly accountId: string;
  private readonly apiToken: string;

  constructor({
    appConfig,
    axiosInstance,
  }: {
    appConfig: AppConfig;
    axiosInstance: AxiosCacheInstance;
  }) {
    this.axios = axiosInstance;
    this.accountId = appConfig.CLOUDFLARE_ACCOUNT_ID;
    this.apiToken = appConfig.CLOUDFLARE_API_TOKEN;
  }

  private getBaseUrl(namespaceId: string) {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${namespaceId}`;
  }

  async put<T>(
    namespaceId: string,
    key: string,
    value: T,
    expirationTtl?: number,
  ): Promise<void> {
    const url = new URL(`${this.getBaseUrl(namespaceId)}/values/${key}`);
    if (expirationTtl) {
      url.searchParams.set("expiration_ttl", expirationTtl.toString());
    }

    await this.axios.put(url.toString(), JSON.stringify(value), {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async get<T>(namespaceId: string, key: string): Promise<T | null> {
    const url = `${this.getBaseUrl(namespaceId)}/values/${key}`;
    try {
      const response = await this.axios.get<T>(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
        responseType: "json",
      });
      return response.data;
    } catch (error: unknown) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async delete(namespaceId: string, key: string): Promise<void> {
    const url = `${this.getBaseUrl(namespaceId)}/values/${key}`;
    await this.axios.delete(url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }
}
