import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import z from "zod";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const server = new McpServer({
  name: "test",
  version: "0.0.1",
});

/**
 * Get the list of all users from the domo. Use limit/offset to paginate. Use this to find users or count them.
 *
 * @param limit Number of users to return (default 50)
 * @param offset Number of users to skip (default 0)
 * @param search Search term for name or email (contains)
 * @param startsWith Filter users starting with this character/string
 * @param role Filter by role (e.g., 'Privileged')
 * @param id Filter by user ID
 */
server.registerTool(
  "get-users",
  {
    description:
      "Get the list of all users from the domo. Use limit/offset to paginate. Use this to find users or count them.",
    inputSchema: z.object({
      limit: z
        .number()
        .optional()
        .describe("Number of users to return (default 50)"),
      offset: z
        .number()
        .optional()
        .describe("Number of users to skip (default 0)"),
      search: z
        .string()
        .optional()
        .describe("Search term for name or email (contains)"),
      startsWith: z
        .string()
        .optional()
        .describe("Filter users starting with this character/string"),
      role: z
        .string()
        .optional()
        .describe("Filter by role (e.g., 'Privileged')"),
      id: z.string().optional().describe("Filter by user ID"),
    }),
  },
  async ({ limit = 50, offset = 0, search, startsWith, role, id }) => {
    try {
      const usersResponse = await axios.get(
        "https://gwcteq-partner.domo.com/api/content/v3/users/?limit=500&offset=0&active=true",
        {
          headers: {
            "X-DOMO-Developer-Token": process.env.DOMO_DEVELOPER_TOKEN,
          },
        }
      );

      let allUsers = usersResponse.data;

      // Filter by search term if provided
      if (search) {
        const term = search.toLowerCase();
        allUsers = allUsers.filter((u: any) => {
          const nameMatch =
            (u.displayName && u.displayName.toLowerCase().includes(term)) ||
            (u.userName && u.userName.toLowerCase().includes(term)) ||
            (u.name && u.name.toLowerCase().includes(term));

          const emailMatch =
            (u.email && u.email.toLowerCase().includes(term)) ||
            (u.emailAddress && u.emailAddress.toLowerCase().includes(term)) ||
            (u.detail?.email && u.detail.email.toLowerCase().includes(term));

          return nameMatch || emailMatch;
        });
      }

      // Filter by startsWith
      if (startsWith) {
        const term = startsWith.toLowerCase();
        allUsers = allUsers.filter((u: any) => {
          const nameMatch =
            (u.displayName && u.displayName.toLowerCase().startsWith(term)) ||
            (u.userName && u.userName.toLowerCase().startsWith(term)) ||
            (u.name && u.name.toLowerCase().startsWith(term));

          return nameMatch;
        });
      }

      // Filter by role
      if (role) {
        const roleTerm = role.toLowerCase();
        allUsers = allUsers.filter(
          (u: any) => u.role && u.role.toLowerCase() === roleTerm
        );
      }

      // Filter by ID
      if (id) {
        allUsers = allUsers.filter((u: any) => String(u.id) === String(id));
      }

      // Simplify objects to save tokens
      const simplifiedUsers = allUsers.map((u: any) => {
        let rawEmail = u.detail?.email || u.email || u.emailAddress || "";
        // Remove _... suffix
        const email = rawEmail.split("_")[0];

        return {
          id: u.id,
          name: u.displayName || u.userName || u.name,
          email: email,
          role: u.role,
        };
      });

      // Paginate
      const pagedUsers = simplifiedUsers.slice(offset, offset + limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: simplifiedUsers.length,
                count: pagedUsers.length,
                users: pagedUsers,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching users: ${error.message} - ${JSON.stringify(
              error.response?.data || ""
            )}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * Search for Domo Dataflows by name using a wildcard query.
 *
 * @param query The search term (e.g., 'rostering')
 * @param count Number of results to return (default 100)
 * @param offset Number of results to skip (default 0)
 */
server.registerTool(
  "search-dataflows",
  {
    description: "Search for Domo Dataflows by name using a wildcard query.",
    inputSchema: z.object({
      query: z.string().describe("The search term (e.g., 'rostering')"),
      count: z
        .number()
        .optional()
        .describe("Number of results to return (default 100)"),
      offset: z
        .number()
        .optional()
        .describe("Number of results to skip (default 0)"),
    }),
  },
  async ({ query, count = 100, offset = 0 }) => {
    try {
      const payload = {
        entities: ["DATAFLOW"],
        filters: [
          {
            field: "name_sort",
            filterType: "wildcard",
            query: `*${query}*`,
          },
        ],
        combineResults: true,
        query: "*",
        count,
        offset,
        sort: {
          isRelevance: false,
          fieldSorts: [
            {
              field: "create_date",
              sortOrder: "DESC",
            },
          ],
        },
      };

      const response = await axios.post(
        "https://gwcteq-partner.domo.com/api/search/v1/query",
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            "X-DOMO-Developer-Token": process.env.DOMO_DEVELOPER_TOKEN,
          },
        }
      );

      const simplifiedResults = (response.data.searchObjects || []).map(
        (obj: any) => ({
          name: obj.name,
          databaseId: obj.databaseId,
          inputDatasets: obj.inputDatasets?.map((ds: any) => ({
            name: ds.name,
            id: ds.id,
          })),
          outputDatasets: obj.outputDatasets?.map((ds: any) => ({
            name: ds.name,
            id: ds.id,
          })),
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: response.data.totalResultCount,
                results: simplifiedResults,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching dataflows: ${
              error.message
            } - ${JSON.stringify(error.response?.data || "")}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * Trigger a Domo Dataflow execution.
 *
 * @param databaseId The ID of the dataflow to run
 */
server.registerTool(
  "run-dataflow",
  {
    description: "Trigger a Domo Dataflow execution.",
    inputSchema: z.object({
      databaseId: z.string().describe("The ID of the dataflow to run"),
    }),
  },
  async ({ databaseId }) => {
    try {
      const response = await axios.post(
        `https://gwcteq-partner.domo.com/api/dataprocessing/v1/dataflows/${databaseId}/executions`,
        {},
        {
          headers: {
            "X-DOMO-Developer-Token": process.env.DOMO_DEVELOPER_TOKEN,
          },
        }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error running dataflow ${databaseId}: ${
              error.message
            } - ${JSON.stringify(error.response?.data || "")}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * Query Domo collections by name.
 *
 * @param query The search term for collection names (e.g., 'rostering_events')
 * @param pageSize Number of results to return (default 100)
 * @param pageNumber Page number to return (default 1)
 */
server.registerTool(
  "query-collections",
  {
    description: "Query Domo Datastores collections by name.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The search term for collection names (e.g., 'rostering_events')"
        ),
      pageSize: z
        .number()
        .optional()
        .describe("Number of results to return (default 100)"),
      pageNumber: z
        .number()
        .optional()
        .describe("Page number to return (default 1)"),
    }),
  },
  async ({ query, pageSize = 100, pageNumber = 1 }) => {
    try {
      const payload = {
        collectionFilteringList: [
          {
            filterType: "nameof",
            typedValue: `%${query}%`,
          },
        ],
        sortBy: "createdOn",
        direction: "desc",
        pageSize,
        pageNumber,
      };

      const response = await axios.post(
        "https://gwcteq-partner.domo.com/api/datastores/v1/collections/query",
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            "X-DOMO-Developer-Token": process.env.DOMO_DEVELOPER_TOKEN,
          },
        }
      );

      const ownersMap = new Map();
      (response.data.ownedBy || []).forEach((o: any) => {
        ownersMap.set(String(o.ownerId), o.ownerName);
      });

      const simplifiedCollections = (response.data.collections || []).map(
        (c: any) => ({
          id: c.id,
          name: c.name,
          createdOn: c.createdOn,
          ownerName: ownersMap.get(String(c.owner)) || "Unknown",
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                totalCount: response.data.totalCollectionCount,
                collections: simplifiedCollections,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying collections: ${
              error.message
            } - ${JSON.stringify(error.response?.data || "")}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * Get all documents from a specific Domo collection.
 *
 * @param collectionId The ID of the collection to fetch documents from
 */
server.registerTool(
  "get-collection-documents",
  {
    description: "Get all documents from a specific Domo collection.",
    inputSchema: z.object({
      collectionId: z
        .string()
        .describe("The ID of the collection (e.g., '18dac2f4-...')"),
    }),
  },
  async ({ collectionId }) => {
    try {
      const response = await axios.get(
        `https://gwcteq-partner.domo.com/api/datastores/v1/collections/${collectionId}/documents`,
        {
          headers: {
            "X-DOMO-Developer-Token": process.env.DOMO_DEVELOPER_TOKEN,
          },
        }
      );

      const simplifiedDocuments = (response.data || []).map((doc: any) => ({
        id: doc.id,
        content: doc.content,
      }));

      // Limit to top 5 samples
      const top5 = simplifiedDocuments.slice(0, 5);

      return {
        content: [
          {
            type: "text",
            description:
              "Top 5 documents from the collection, we only show 5 documents because of the limit",
            text: JSON.stringify(top5, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching documents for collection ${collectionId}: ${
              error.message
            } - ${JSON.stringify(error.response?.data || "")}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * Search for Domo Workflows by name using a query.
 *
 * @param query The search term (e.g., 'magic_rostering')
 * @param count Number of results to return (default 1000)
 * @param offset Number of results to skip (default 0)
 */
server.registerTool(
  "search-workflows",
  {
    description: "Search for Domo Workflows by name.",
    inputSchema: z.object({
      query: z.string().describe("The search term (e.g., 'magic_rostering')"),
      count: z
        .number()
        .optional()
        .describe("Number of results to return (default 1000)"),
      offset: z
        .number()
        .optional()
        .describe("Number of results to skip (default 0)"),
    }),
  },
  async ({ query, count = 1000, offset = 0 }) => {
    try {
      const payload = {
        query: `*${query}*`,
        entityList: [["workflow_model"]],
        count,
        offset,
        sort: {
          fieldSorts: [
            {
              field: "last_modified",
              sortOrder: "DESC",
            },
          ],
          isRelevance: false,
        },
        filters: [],
        useEntities: true,
        combineResults: true,
        facetValueLimit: 1000,
        hideSearchObjects: false,
      };

      const response = await axios.post(
        "https://gwcteq-partner.domo.com/api/search/v1/query",
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            "X-DOMO-Developer-Token": process.env.DOMO_DEVELOPER_TOKEN,
          },
        }
      );

      const simplifiedResults = (response.data.searchObjects || []).map(
        (obj: any) => ({
          id: obj.uuid,
          name: obj.name,
          ownedName: obj.ownedByName,
          type: obj.entityType,
          active: obj.active,
          totalVersions: obj.totalVersions,
          deployedVersions: obj.deployedVersions,
          createDate: obj.createDate,
          lastModified: obj.lastModified
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: response.data.totalResultCount,
                results: simplifiedResults,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching workflows: ${
              error.message
            } - ${JSON.stringify(error.response?.data || "")}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * Get detailed information about a specific Domo workflow model.
 *
 * @param workflowId The ID of the workflow model (e.g., '3a0a0f98-...')
 */
server.registerTool(
  "get-workflow-model",
  {
    description:
      "Get detailed information about a specific Domo workflow model.",
    inputSchema: z.object({
      workflowId: z
        .string()
        .describe("The ID of the workflow model (e.g., '3a0a0f98-...')"),
    }),
  },
  async ({ workflowId }) => {
    try {
      const response = await axios.get(
        `https://gwcteq-partner.domo.com/api/workflow/v1/models/${workflowId}?parts=users`,
        {
          headers: {
            "X-DOMO-Developer-Token": process.env.DOMO_DEVELOPER_TOKEN,
          },
        }
      );

      const simplifiedBasicInfo = {
        name: response.data.name,
        id: response.data.id,
        createdOn: response.data.createdOn,
        updatedOn: response.data.updatedOn,
      };

      const simplifiedVersions = (response.data.versions || []).map(
        (v: any) => ({
          version: v.version,
          createdOn: v.createdOn,
          active: v.active,
        })
      );

      const simplifiedPermissions = (response.data.userPermissions || []).map(
        (p: any) => ({
          name: p.name,
          permissions: p.permissions,
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                basicInfo: simplifiedBasicInfo,
                versions: simplifiedVersions,
                userPermissions: simplifiedPermissions,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching workflow model ${workflowId}: ${
              error.message
            } - ${JSON.stringify(error.response?.data || "")}`,
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
