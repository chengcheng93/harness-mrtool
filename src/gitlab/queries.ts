export const LABEL_GLOBAL_IDS_QUERY = `query HarnessMrtoolLabelGlobalIds($fullPath: ID!, $after: String) {
  project(fullPath: $fullPath) {
    id
    fullPath
    labels(includeAncestorGroups: true, first: 100, after: $after) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const CAPABILITIES_QUERY = `query HarnessMrtoolCapabilities {
  mutation: __type(name: "Mutation") {
    fields { name }
  }
  input: __type(name: "MergeRequestSetLabelsInput") {
    inputFields { name }
  }
  mode: __type(name: "MutationOperationMode") {
    enumValues { name }
  }
}`;

export const SET_LABELS_MUTATION = `mutation HarnessMrtoolSetLabels($input: MergeRequestSetLabelsInput!) {
  mergeRequestSetLabels(input: $input) {
    errors
    mergeRequest { iid }
  }
}`;
