// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { t } from "ttag";
import { assoc, assocIn, chain, getIn, updateIn } from "icepick";
import _ from "underscore";
import slugg from "slugg";
import { humanize } from "metabase/lib/formatting";
import Utils from "metabase/lib/utils";
import { ParameterValuesConfig } from "metabase-types/api";
import {
  Card,
  DatasetQuery,
  NativeDatasetQuery,
} from "metabase-types/types/Card";
import {
  DependentMetadataItem,
  TemplateTag,
  TemplateTags,
} from "metabase-types/types/Query";
import { DatabaseEngine, DatabaseId } from "metabase-types/types/Database";
import Question from "metabase-lib/Question";
import Table from "metabase-lib/metadata/Table";
import Database from "metabase-lib/metadata/Database";
import AtomicQuery from "metabase-lib/queries/AtomicQuery";
import { getTemplateTagParameter } from "metabase-lib/parameters/utils/template-tags";
import Variable from "metabase-lib/variables/Variable";
import TemplateTagVariable from "metabase-lib/variables/TemplateTagVariable";
import { createTemplateTag } from "metabase-lib/queries/TemplateTag";
import ValidationError from "metabase-lib/ValidationError";
import { isFieldReference } from "metabase-lib/references";
import Dimension, { FieldDimension, TemplateTagDimension } from "../Dimension";
import DimensionOptions from "../DimensionOptions";

import { getNativeQueryTable } from "./utils/native-query-table";

type DimensionFilter = (dimension: Dimension) => boolean;
type VariableFilter = (variable: Variable) => boolean;
export const NATIVE_QUERY_TEMPLATE: NativeDatasetQuery = {
  database: null,
  type: "native",
  native: {
    query: "",
    "template-tags": {},
  },
};

///////////////////////////
// QUERY TEXT TAG UTILS

const VARIABLE_TAG_REGEX: RegExp = /\{\{\s*([A-Za-z0-9_\.]+)\s*\}\}/g;
const SNIPPET_TAG_REGEX: RegExp = /\{\{\s*(snippet:\s*[^}]+)\s*\}\}/g;
export const CARD_TAG_REGEX: RegExp =
  /\{\{\s*(#([0-9]*)(-[a-z0-9-]*)?)\s*\}\}/g;
const TAG_REGEXES: RegExp[] = [
  VARIABLE_TAG_REGEX,
  SNIPPET_TAG_REGEX,
  CARD_TAG_REGEX,
];

// look for variable usage in the query (like '{{varname}}').  we only allow alphanumeric characters for the variable name
// a variable name can optionally end with :start or :end which is not considered part of the actual variable name
// expected pattern is like mustache templates, so we are looking for something like {{category}}
// anything that doesn't match our rule is ignored, so {{&foo!}} would simply be ignored
// See unit tests for examples
export function recognizeTemplateTags(queryText: string): string[] {
  const tagNames = TAG_REGEXES.flatMap(r =>
    Array.from(queryText.matchAll(r)),
  ).map(m => m[1]);
  return _.uniq(tagNames);
}

// matches '#123-foo-bar' and '#123' but not '#123foo'
const CARD_TAG_NAME_REGEX: RegExp = /^#([0-9]*)(-[a-z0-9-]*)?$/;

function tagRegex(tagName: string): RegExp {
  return new RegExp(`{{\\s*${tagName}\\s*}}`, "g");
}

function replaceTagName(
  query: NativeQuery,
  oldTagName: string,
  newTagName: string,
): NativeQuery {
  const queryText = query
    .queryText()
    .replace(tagRegex(oldTagName), `{{${newTagName}}}`);
  return query.setQueryText(queryText);
}

export function cardIdFromTagName(name: string): number | null {
  const match = name.match(CARD_TAG_NAME_REGEX);
  return parseInt(match?.[1]) || null;
}

function isCardTagName(tagName: string): boolean {
  return CARD_TAG_NAME_REGEX.test(tagName);
}

function snippetNameFromTagName(name: string): string {
  return name.slice("snippet:".length).trim();
}

function isSnippetTagName(name: string): boolean {
  return name.startsWith("snippet:");
}

export function updateCardTemplateTagNames(
  query: NativeQuery,
  cards: Card[],
): NativeQuery {
  const cardById = _.indexBy(cards, "id");
  const tags = query
    .templateTags()
    // only tags for cards
    .filter(tag => tag.type === "card")
    // only tags for given cards
    .filter(tag => cardById[tag["card-id"]]);
  // reduce over each tag, updating query text with the new tag name
  return tags.reduce((query, tag) => {
    const card = cardById[tag["card-id"]];
    const newTagName = `#${card.id}-${slugg(card.name)}`;
    return replaceTagName(query, tag.name, newTagName);
  }, query);
}

// QUERY TEXT TAG UTILS END
///////////////////////////

export default class NativeQuery extends AtomicQuery {
  // For Flow type completion
  _nativeDatasetQuery: NativeDatasetQuery;

  constructor(
    question: Question,
    datasetQuery: DatasetQuery = NATIVE_QUERY_TEMPLATE,
  ) {
    super(question, datasetQuery);
    this._nativeDatasetQuery = datasetQuery as NativeDatasetQuery;
  }

  static isDatasetQueryType(datasetQuery: DatasetQuery) {
    return datasetQuery?.type === NATIVE_QUERY_TEMPLATE.type;
  }

  /* Query superclass methods */
  hasData() {
    return (
      this.databaseId() != null && (!this.requiresTable() || this.collection())
    );
  }

  canRun() {
    return Boolean(
      this.hasData() &&
        this.queryText().length > 0 &&
        this._allTemplateTagsAreValid(),
    );
  }

  isEmpty() {
    return this.databaseId() == null || this.queryText().length === 0;
  }

  clean() {
    return this.setDatasetQuery(
      updateIn(
        this.datasetQuery(),
        ["native", "template-tags"],
        tt => tt || {},
      ),
    );
  }

  /* AtomicQuery superclass methods */
  tables(): Table[] | null | undefined {
    const database = this.database();
    return (database && database.tables) || null;
  }

  databaseId(): DatabaseId | null | undefined {
    // same for both structured and native
    return this._nativeDatasetQuery.database;
  }

  database(): Database | null | undefined {
    const databaseId = this.databaseId();
    return databaseId != null ? this._metadata.database(databaseId) : null;
  }

  engine(): DatabaseEngine | null | undefined {
    const database = this.database();
    return database && database.engine;
  }

  /**
   * Returns true if the database metadata (or lack thererof indicates the user can modify and run this query
   */
  readOnly() {
    const database = this.database();
    return !database || database.native_permissions !== "write";
  }

  // This basically just mirrors StructuredQueries `isEditable` method,
  // so there is no need to do `isStructured ? isEditable() : readOnly()`
  isEditable() {
    return !this.readOnly();
  }

  /* Methods unique to this query type */

  /**
   * @returns a new query with the provided Database set.
   */
  setDatabase(database: Database): NativeQuery {
    return this.setDatabaseId(database.id);
  }

  setDatabaseId(databaseId: DatabaseId): NativeQuery {
    if (databaseId !== this.databaseId()) {
      // TODO: this should reset the rest of the query?
      return new NativeQuery(
        this._originalQuestion,
        assoc(this.datasetQuery(), "database", databaseId),
      );
    } else {
      return this;
    }
  }

  setDefaultCollection(): NativeQuery {
    if (this.requiresTable()) {
      const tables = this.tables();

      if (tables && tables.length > 0) {
        return this.setCollectionName(tables[0].name);
      }
    }

    return this;
  }

  hasWritePermission() {
    const database = this.database();
    return database != null && database.native_permissions === "write";
  }

  supportsNativeParameters() {
    const database = this.database();
    return (
      database != null && _.contains(database.features, "native-parameters")
    );
  }

  table(): Table | null {
    return getNativeQueryTable(this);
  }

  sourceTable(): null {
    // Source tables are only available in structured queries,
    // this method exists to keep query API consistent
    return null;
  }

  queryText(): string {
    return getIn(this.datasetQuery(), ["native", "query"]) || "";
  }

  setQueryText(newQueryText: string): NativeQuery {
    return new NativeQuery(
      this._originalQuestion,
      chain(this._datasetQuery)
        .assocIn(["native", "query"], newQueryText)
        .assocIn(
          ["native", "template-tags"],
          this._getUpdatedTemplateTags(newQueryText),
        )
        .value(),
    );
  }

  collection(): string | null | undefined {
    return getIn(this.datasetQuery(), ["native", "collection"]);
  }

  setCollectionName(newCollection: string) {
    return new NativeQuery(
      this._originalQuestion,
      assocIn(this._datasetQuery, ["native", "collection"], newCollection),
    );
  }

  setParameterIndex(id: string, newIndex: number) {
    // NOTE: currently all NativeQuery parameters are implicitly generated from
    // template tags, and the order is determined by the key order
    return new NativeQuery(
      this._originalQuestion,
      updateIn(
        this._datasetQuery,
        ["native", "template-tags"],
        templateTags => {
          const entries = Array.from(Object.entries(templateTags));

          const oldIndex = _.findIndex(entries, entry => entry[1].id === id);

          entries.splice(newIndex, 0, entries.splice(oldIndex, 1)[0]);
          return _.object(entries);
        },
      ),
    );
  }

  lineCount(): number {
    const queryText = this.queryText();
    return queryText ? queryText.split(/\n/g).length : 0;
  }

  /**
   * Whether the DB selector should be a DB + Table selector. Mongo needs both DB + Table.
   */
  requiresTable() {
    return this.engine() === "mongo";
  }

  templateTagsMap(): TemplateTags {
    return getIn(this.datasetQuery(), ["native", "template-tags"]) || {};
  }

  templateTags(): TemplateTag[] {
    return Object.values(this.templateTagsMap());
  }

  variableTemplateTags(): TemplateTag[] {
    return this.templateTags().filter(t =>
      ["dimension", "text", "number", "date"].includes(t.type),
    );
  }

  hasVariableTemplateTags(): boolean {
    return this.variableTemplateTags().length > 0;
  }

  hasSnippets() {
    return this.templateTags().some(t => t.type === "snippet");
  }

  referencedQuestionIds(): number[] {
    return this.templateTags()
      .filter(tag => tag.type === "card")
      .map(tag => tag["card-id"]);
  }

  private _validateTemplateTags() {
    return this.templateTags()
      .map(tag => {
        if (!tag["display-name"]) {
          return new ValidationError(t`Missing widget label: ${tag.name}`);
        }
        const dimension = new TemplateTagDimension(
          tag.name,
          this.metadata(),
          this,
        );
        if (!dimension) {
          return new ValidationError(t`Invalid template tag: ${tag.name}`);
        }

        return dimension.validateTemplateTag();
      })
      .filter(
        (maybeError): maybeError is ValidationError => maybeError != null,
      );
  }

  private _allTemplateTagsAreValid() {
    const tagErrors = this._validateTemplateTags();
    return tagErrors.length === 0;
  }

  setTemplateTag(name: string, tag: TemplateTag): NativeQuery {
    return this.setDatasetQuery(
      updateIn(this.datasetQuery(), ["native", "template-tags"], tags => ({
        ...tags,
        [name]: tag,
      })),
    );
  }

  setTemplateTagConfig(
    tag: TemplateTag,
    config: ParameterValuesConfig,
  ): NativeQuery {
    const newParameter = getTemplateTagParameter(tag, config);
    return this.question().setParameter(tag.id, newParameter).query();
  }

  setDatasetQuery(datasetQuery: DatasetQuery): NativeQuery {
    return new NativeQuery(this._originalQuestion, datasetQuery);
  }

  dimensionOptions(
    dimensionFilter: DimensionFilter = _.identity,
    operatorFilter = _.identity,
  ): DimensionOptions {
    const dimensions = this.templateTags()
      .filter(tag => tag.type === "dimension" && operatorFilter(tag))
      .map(tag => new TemplateTagDimension(tag.name, this.metadata(), this))
      .filter(dimension => dimensionFilter(dimension));
    return new DimensionOptions({
      dimensions: dimensions,
      count: dimensions.length,
    });
  }

  variables(variableFilter: VariableFilter = () => true): Variable[] {
    return this.templateTags()
      .filter(tag => tag.type !== "dimension")
      .map(tag => new TemplateTagVariable([tag.name], this.metadata(), this))
      .filter(variableFilter);
  }

  updateSnippetsWithIds(snippets): NativeQuery {
    const tagsBySnippetName = _.chain(this.templateTags())
      .filter(tag => tag.type === "snippet" && tag["snippet-id"] == null)
      .groupBy(tag => tag["snippet-name"])
      .value();

    if (Object.keys(tagsBySnippetName).length === 0) {
      // no need to check if there are no tags
      return this;
    }

    let query = this;

    for (const snippet of snippets) {
      for (const tag of tagsBySnippetName[snippet.name] || []) {
        query = query.setTemplateTag(tag.name, {
          ...tag,
          "snippet-id": snippet.id,
        });
      }
    }

    return query;
  }

  updateSnippetNames(snippets): NativeQuery {
    const tagsBySnippetId = _.chain(this.templateTags())
      .filter(tag => tag.type === "snippet")
      .groupBy(tag => tag["snippet-id"])
      .value();

    if (Object.keys(tagsBySnippetId).length === 0) {
      // no need to check if there are no tags
      return this;
    }

    let queryText = this.queryText();

    for (const snippet of snippets) {
      for (const tag of tagsBySnippetId[snippet.id] || []) {
        if (tag["snippet-name"] !== snippet.name) {
          queryText = queryText.replace(
            tagRegex(tag.name),
            `{{snippet: ${snippet.name}}}`,
          );
        }
      }
    }

    if (queryText !== this.queryText()) {
      return this.setQueryText(queryText).updateSnippetsWithIds(snippets);
    }

    return this;
  }

  /**
   * special handling for NATIVE cards to automatically detect parameters ... {{varname}}
   */
  private _getUpdatedTemplateTags(queryText: string): TemplateTags {
    if (queryText && this.supportsNativeParameters()) {
      const tags = recognizeTemplateTags(queryText);
      const existingTemplateTags = this.templateTagsMap();
      const existingTags = Object.keys(existingTemplateTags);

      // if we ended up with any variables in the query then update the card parameters list accordingly
      if (tags.length > 0 || existingTags.length > 0) {
        const newTags = _.difference(tags, existingTags);

        const oldTags = _.difference(existingTags, tags);

        const templateTags = { ...existingTemplateTags };

        if (oldTags.length === 1 && newTags.length === 1) {
          // renaming
          const newTag = { ...templateTags[oldTags[0]] };

          if (newTag["display-name"] === humanize(oldTags[0])) {
            newTag["display-name"] = humanize(newTags[0]);
          }

          newTag.name = newTags[0];

          if (isCardTagName(newTag.name)) {
            newTag.type = "card";
            newTag["card-id"] = cardIdFromTagName(newTag.name);
          } else if (isSnippetTagName(newTag.name)) {
            newTag.type = "snippet";
            newTag["snippet-name"] = snippetNameFromTagName(newTag.name);
          }

          templateTags[newTag.name] = newTag;
          delete templateTags[oldTags[0]];
        } else {
          // remove old vars
          for (const name of oldTags) {
            delete templateTags[name];
          }

          // create new vars
          for (const tagName of newTags) {
            templateTags[tagName] = createTemplateTag(tagName);

            // parse card ID from tag name for card query template tags
            if (isCardTagName(tagName)) {
              templateTags[tagName] = Object.assign(templateTags[tagName], {
                type: "card",
                "card-id": cardIdFromTagName(tagName),
              });
            } else if (isSnippetTagName(tagName)) {
              // extract snippet name from snippet tag
              templateTags[tagName] = Object.assign(templateTags[tagName], {
                type: "snippet",
                "snippet-name": snippetNameFromTagName(tagName),
              });
            }
          }
        }

        // ensure all tags have an id since we need it for parameter values to work
        for (const tag: TemplateTag of Object.values(templateTags)) {
          if (tag.id == null) {
            tag.id = Utils.uuid();
          }
        }

        return templateTags;
      }
    }

    return {};
  }

  dependentMetadata(): DependentMetadataItem[] {
    const templateTags = this.templateTags();
    return templateTags
      .filter(
        tag => tag.type === "dimension" && isFieldReference(tag.dimension),
      )
      .map(tag => {
        const dimension = FieldDimension.parseMBQL(
          tag.dimension,
          this.metadata(),
        );
        return {
          type: "field",
          id: dimension.field().id,
        };
      });
  }
}
