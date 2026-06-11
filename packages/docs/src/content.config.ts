import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    // Extend the Starlight docs schema with the optional prototype article
    // `.toc-meta` footer fields. The prototype `docs-article.html` renders five
    // key/value rows below the on-this-page list (edit / source / version /
    // updated / read). Those values are per-article static metadata that has no
    // home in the default Starlight schema, so they are surfaced as optional
    // frontmatter and rendered by the TableOfContents override. Pages that omit
    // `tocMeta` fall back to the editUrl-only meta row.
    schema: docsSchema({
      extend: z.object({
        tocMeta: z
          .object({
            version: z.string().optional(),
            updated: z.string().optional(),
            readTime: z.string().optional(),
          })
          .optional(),
      }),
    }),
  }),
};
