import { describe, expect, it } from "vitest";
import { mysqlOptionsFromEnvironment } from "./mysql-source.js";

describe("MySQL sales source configuration", () => {
  it("does not guess missing credentials", () => {
    expect(mysqlOptionsFromEnvironment({})).toBeUndefined();
  });

  it("accepts explicit loopback configuration", () => {
    expect(mysqlOptionsFromEnvironment({
      BPA_MYSQL_HOST: "127.0.0.1",
      BPA_MYSQL_PORT: "3306",
      BPA_MYSQL_USER: "bpa_sales_reader",
      BPA_MYSQL_PASSWORD: "redacted-test-value",
      BPA_MYSQL_DATABASE: "ecom_profit"
    })).toMatchObject({ host: "127.0.0.1", port: 3306, database: "ecom_profit" });
  });
});
