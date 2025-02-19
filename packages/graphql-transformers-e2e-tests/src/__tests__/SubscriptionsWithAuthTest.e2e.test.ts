import { ResourceConstants } from 'graphql-transformer-common';
import { GraphQLTransform } from 'graphql-transformer-core';
import { DynamoDBModelTransformer } from 'graphql-dynamodb-transformer';
import { ModelAuthTransformer } from 'graphql-auth-transformer';
import * as fs from 'fs';
import { CloudFormationClient } from '../CloudFormationClient';
import { Output } from 'aws-sdk/clients/cloudformation';
import { default as S3 } from 'aws-sdk/clients/s3';
import { CreateBucketRequest } from 'aws-sdk/clients/s3';
import { default as CognitoClient } from 'aws-sdk/clients/cognitoidentityserviceprovider';
import AWSAppSyncClient, { AUTH_TYPE } from 'aws-appsync';
import { AWS } from '@aws-amplify/core';
import { Auth } from 'aws-amplify';
import gql from 'graphql-tag';
import { S3Client } from '../S3Client';
import { cleanupStackAfterTest, deploy } from '../deployNestedStacks';
import { default as moment } from 'moment';
import { IAM as cfnIAM, Cognito as cfnCognito } from 'cloudform-types';
import {
  createUserPool,
  createUserPoolClient,
  createGroup,
  addUserToGroup,
  configureAmplify,
  signupUser,
  authenticateUser,
} from '../cognitoUtils';
import 'isomorphic-fetch';
import { API } from 'aws-amplify';
import { GRAPHQL_AUTH_MODE } from '@aws-amplify/api';
import { withTimeOut } from '../promiseWithTimeout';
import * as Observable from 'zen-observable';

// tslint:disable: no-use-before-declare

// To overcome of the way of how AmplifyJS picks up currentUserCredentials
const anyAWS = AWS as any;
if (anyAWS && anyAWS.config && anyAWS.config.credentials) {
  delete anyAWS.config.credentials;
}
const featureFlags = {
  getBoolean: jest.fn().mockImplementation((name, defaultValue) => {
    if (name === 'improvePluralization') {
      return true;
    }
    return;
  }),
  getNumber: jest.fn(),
  getObject: jest.fn(),
};

// to deal with bug in cognito-identity-js
(global as any).fetch = require('node-fetch');
// to deal with subscriptions in node env
(global as any).WebSocket = require('ws');

// delay times
const SUBSCRIPTION_DELAY = 10000;
const PROPAGATION_DELAY = 5000;
const JEST_TIMEOUT = 2000000;
const SUBSCRIPTION_TIMEOUT = 10000;

jest.setTimeout(JEST_TIMEOUT);

const AWS_REGION = 'us-west-2';
const cf = new CloudFormationClient(AWS_REGION);
const BUILD_TIMESTAMP = moment().format('YYYYMMDDHHmmss');
const STACK_NAME = `SubscriptionAuthTests-${BUILD_TIMESTAMP}`;
const BUCKET_NAME = `subscription-auth-tests-bucket-${BUILD_TIMESTAMP}`;
const LOCAL_BUILD_ROOT = '/tmp/subscription_auth_tests/';
const DEPLOYMENT_ROOT_KEY = 'deployments';
const AUTH_ROLE_NAME = `${STACK_NAME}-authRole`;
const UNAUTH_ROLE_NAME = `${STACK_NAME}-unauthRole`;
const IDENTITY_POOL_NAME = `SubscriptionAuthModelAuthTransformerTest_${BUILD_TIMESTAMP}_identity_pool`;
const USER_POOL_CLIENTWEB_NAME = `subs_auth_${BUILD_TIMESTAMP}_clientweb`;
const USER_POOL_CLIENT_NAME = `subs_auth_${BUILD_TIMESTAMP}_client`;

let GRAPHQL_ENDPOINT = undefined;

/**
 * Client 1 is logged in and is a member of the Admin group.
 */
let GRAPHQL_CLIENT_1: AWSAppSyncClient<any> = undefined;

/**
 * Client 2 is logged in and is a member of the Devs group.
 */
let GRAPHQL_CLIENT_2: AWSAppSyncClient<any> = undefined;

/**
 * Client 3 is logged in and has no group memberships.
 */
let GRAPHQL_CLIENT_3: AWSAppSyncClient<any> = undefined;

/**
 * Auth IAM Client
 */
let GRAPHQL_IAM_AUTH_CLIENT: AWSAppSyncClient<any> = undefined;

/**
 * API Key Client
 */
let GRAPHQL_APIKEY_CLIENT: AWSAppSyncClient<any> = undefined;

let USER_POOL_ID = undefined;

let API_KEY: string = undefined;

const USERNAME1 = 'user1@test.com';
const USERNAME2 = 'user2@test.com';
const USERNAME3 = 'user3@test.com';
const TMP_PASSWORD = 'Password123!';
const REAL_PASSWORD = 'Password1234!';

const INSTRUCTOR_GROUP_NAME = 'Instructor';
const MEMBER_GROUP_NAME = 'Member';
const ADMIN_GROUP_NAME = 'Admin';

const cognitoClient = new CognitoClient({ apiVersion: '2016-04-19', region: AWS_REGION });
const customS3Client = new S3Client(AWS_REGION);
const awsS3Client = new S3({ region: AWS_REGION });

// interface inputs
interface MemberInput {
  id: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface CreateStudentInput {
  id?: string;
  name?: string;
  email?: string;
  ssn?: string;
}

interface UpdateStudentInput {
  id: string;
  name?: string;
  email?: string;
  ssn?: string;
}

interface CreatePostInput {
  id?: string;
  title: string;
  postOwner: string;
}

interface CreateTodoInput {
  id?: string;
  name?: string;
  description?: string;
}

interface UpdateTodoInput {
  id: string;
  name?: string;
  description?: string;
}

interface DeleteTypeInput {
  id: string;
}

function outputValueSelector(key: string) {
  return (outputs: Output[]) => {
    const output = outputs.find((o: Output) => o.OutputKey === key);
    return output ? output.OutputValue : null;
  };
}

async function createBucket(name: string) {
  return new Promise((res, rej) => {
    const params: CreateBucketRequest = {
      Bucket: name,
    };
    awsS3Client.createBucket(params, (err, data) => (err ? rej(err) : res(data)));
  });
}

async function deleteBucket(name: string) {
  return new Promise((res, rej) => {
    const params: CreateBucketRequest = {
      Bucket: name,
    };
    awsS3Client.deleteBucket(params, (err, data) => (err ? rej(err) : res(data)));
  });
}
beforeEach(async () => {
  try {
    await Auth.signOut();
  } catch (ex) {
    // don't need to fail tests on this error
  }
});
beforeAll(async () => {
  // Create a stack for the post model with auth enabled.
  if (!fs.existsSync(LOCAL_BUILD_ROOT)) {
    fs.mkdirSync(LOCAL_BUILD_ROOT);
  }
  await createBucket(BUCKET_NAME);
  const validSchema = `
    # Owners may update their owned records.
    # Instructors may create Student records.
    # Any authenticated user may view Student names & emails.
    # Only Owners can see the ssn

    type Student @model
    @auth(rules: [
        {allow: owner}
        {allow: groups, groups: ["Instructor"]}
    ]) {
        id: String,
        name: String,
        email: AWSEmail,
        ssn: String @auth(rules: [{allow: owner}])
    }

    type Member @model
    @auth(rules: [
      { allow: groups, groups: ["Admin"] }
      { allow: groups, groups: ["Member"], operations: [read] }
    ]) {
      id: ID
      name: String
      createdAt: AWSDateTime
      updatedAt: AWSDateTime
    }

    type Post @model
        @auth(rules: [
            { allow: owner, ownerField: "postOwner" }
            { allow: private, operations: [read], provider: iam }
        ])
    {
        id: ID!
        title: String
        postOwner: String
    }

    type Todo @model @auth(rules: [
        { allow: public }
    ]){
        id: ID!
        name: String @auth(rules: [
            { allow: private, provider: iam }
        ])
        description: String
    }`;

  const transformer = new GraphQLTransform({
    featureFlags,
    transformers: [
      new DynamoDBModelTransformer(),
      new ModelAuthTransformer({
        authConfig: {
          defaultAuthentication: {
            authenticationType: 'AMAZON_COGNITO_USER_POOLS',
          },
          additionalAuthenticationProviders: [
            {
              authenticationType: 'API_KEY',
              apiKeyConfig: {
                description: 'E2E Test API Key',
                apiKeyExpirationDays: 300,
              },
            },
            {
              authenticationType: 'AWS_IAM',
            },
          ],
        },
      }),
    ],
  });
  const userPoolResponse = await createUserPool(cognitoClient, `UserPool${STACK_NAME}`);
  USER_POOL_ID = userPoolResponse.UserPool.Id;
  const userPoolClientResponse = await createUserPoolClient(cognitoClient, USER_POOL_ID, `UserPool${STACK_NAME}`);
  const userPoolClientId = userPoolClientResponse.UserPoolClient.ClientId;
  try {
    // Clean the bucket
    const out = transformer.transform(validSchema);

    const authRole = new cfnIAM.Role({
      RoleName: AUTH_ROLE_NAME,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              Federated: 'cognito-identity.amazonaws.com',
            },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              'ForAnyValue:StringLike': {
                'cognito-identity.amazonaws.com:amr': 'authenticated',
              },
            },
          },
        ],
      },
    });

    const unauthRole = new cfnIAM.Role({
      RoleName: UNAUTH_ROLE_NAME,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              Federated: 'cognito-identity.amazonaws.com',
            },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              'ForAnyValue:StringLike': {
                'cognito-identity.amazonaws.com:amr': 'unauthenticated',
              },
            },
          },
        ],
      },
      Policies: [
        new cfnIAM.Role.Policy({
          PolicyName: 'appsync-unauthrole-policy',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['appsync:GraphQL'],
                Resource: [
                  {
                    'Fn::Join': [
                      '',
                      [
                        'arn:aws:appsync:',
                        { Ref: 'AWS::Region' },
                        ':',
                        { Ref: 'AWS::AccountId' },
                        ':apis/',
                        {
                          'Fn::GetAtt': ['GraphQLAPI', 'ApiId'],
                        },
                        '/*',
                      ],
                    ],
                  },
                ],
              },
            ],
          },
        }),
      ],
    });

    const identityPool = new cfnCognito.IdentityPool({
      IdentityPoolName: IDENTITY_POOL_NAME,
      CognitoIdentityProviders: [
        {
          ClientId: {
            Ref: 'UserPoolClient',
          },
          ProviderName: {
            'Fn::Sub': [
              'cognito-idp.${region}.amazonaws.com/${client}',
              {
                region: {
                  Ref: 'AWS::Region',
                },
                client: USER_POOL_ID,
              },
            ],
          },
        } as unknown,
        {
          ClientId: {
            Ref: 'UserPoolClientWeb',
          },
          ProviderName: {
            'Fn::Sub': [
              'cognito-idp.${region}.amazonaws.com/${client}',
              {
                region: {
                  Ref: 'AWS::Region',
                },
                client: USER_POOL_ID,
              },
            ],
          },
        } as unknown,
      ],
      AllowUnauthenticatedIdentities: true,
    });

    const identityPoolRoleMap = new cfnCognito.IdentityPoolRoleAttachment({
      IdentityPoolId: { Ref: 'IdentityPool' } as unknown as string,
      Roles: {
        unauthenticated: { 'Fn::GetAtt': ['UnauthRole', 'Arn'] },
        authenticated: { 'Fn::GetAtt': ['AuthRole', 'Arn'] },
      },
    });

    const userPoolClientWeb = new cfnCognito.UserPoolClient({
      ClientName: USER_POOL_CLIENTWEB_NAME,
      RefreshTokenValidity: 30,
      UserPoolId: USER_POOL_ID,
    });

    const userPoolClient = new cfnCognito.UserPoolClient({
      ClientName: USER_POOL_CLIENT_NAME,
      GenerateSecret: true,
      RefreshTokenValidity: 30,
      UserPoolId: USER_POOL_ID,
    });

    out.rootStack.Resources.IdentityPool = identityPool;
    out.rootStack.Resources.IdentityPoolRoleMap = identityPoolRoleMap;
    out.rootStack.Resources.UserPoolClientWeb = userPoolClientWeb;
    out.rootStack.Resources.UserPoolClient = userPoolClient;
    out.rootStack.Outputs.IdentityPoolId = { Value: { Ref: 'IdentityPool' } };
    out.rootStack.Outputs.IdentityPoolName = { Value: { 'Fn::GetAtt': ['IdentityPool', 'Name'] } };

    out.rootStack.Resources.AuthRole = authRole;
    out.rootStack.Outputs.AuthRoleArn = { Value: { 'Fn::GetAtt': ['AuthRole', 'Arn'] } };
    out.rootStack.Resources.UnauthRole = unauthRole;
    out.rootStack.Outputs.UnauthRoleArn = { Value: { 'Fn::GetAtt': ['UnauthRole', 'Arn'] } };

    // Since we're doing the policy here we've to remove the transformer generated artifacts from
    // the generated stack.
    const maxPolicyCount = 10;
    for (let i = 0; i < maxPolicyCount; i++) {
      const paddedIndex = `${i + 1}`.padStart(2, '0');
      const authResourceName = `${ResourceConstants.RESOURCES.AuthRolePolicy}${paddedIndex}`;
      const unauthResourceName = `${ResourceConstants.RESOURCES.UnauthRolePolicy}${paddedIndex}`;

      if (out.rootStack.Resources[authResourceName]) {
        delete out.rootStack.Resources[authResourceName];
      }

      if (out.rootStack.Resources[unauthResourceName]) {
        delete out.rootStack.Resources[unauthResourceName];
      }
    }

    delete out.rootStack.Parameters.authRoleName;
    delete out.rootStack.Parameters.unauthRoleName;

    for (const key of Object.keys(out.rootStack.Resources)) {
      if (
        out.rootStack.Resources[key].Properties &&
        out.rootStack.Resources[key].Properties.Parameters &&
        out.rootStack.Resources[key].Properties.Parameters.unauthRoleName
      ) {
        delete out.rootStack.Resources[key].Properties.Parameters.unauthRoleName;
      }

      if (
        out.rootStack.Resources[key].Properties &&
        out.rootStack.Resources[key].Properties.Parameters &&
        out.rootStack.Resources[key].Properties.Parameters.authRoleName
      ) {
        delete out.rootStack.Resources[key].Properties.Parameters.authRoleName;
      }
    }

    for (const stackKey of Object.keys(out.stacks)) {
      const stack = out.stacks[stackKey];

      for (const key of Object.keys(stack.Resources)) {
        if (stack.Parameters && stack.Parameters.unauthRoleName) {
          delete stack.Parameters.unauthRoleName;
        }
        if (stack.Parameters && stack.Parameters.authRoleName) {
          delete stack.Parameters.authRoleName;
        }
        if (
          stack.Resources[key].Properties &&
          stack.Resources[key].Properties.Parameters &&
          stack.Resources[key].Properties.Parameters.unauthRoleName
        ) {
          delete stack.Resources[key].Properties.Parameters.unauthRoleName;
        }
        if (
          stack.Resources[key].Properties &&
          stack.Resources[key].Properties.Parameters &&
          stack.Resources[key].Properties.Parameters.authRoleName
        ) {
          delete stack.Resources[key].Properties.Parameters.authRoleName;
        }
      }
    }

    const params = {
      CreateAPIKey: '1',
      AuthCognitoUserPoolId: USER_POOL_ID,
    };

    const finishedStack = await deploy(
      customS3Client,
      cf,
      STACK_NAME,
      out,
      params,
      LOCAL_BUILD_ROOT,
      BUCKET_NAME,
      DEPLOYMENT_ROOT_KEY,
      BUILD_TIMESTAMP,
    );
    expect(finishedStack).toBeDefined();
    const getApiEndpoint = outputValueSelector(ResourceConstants.OUTPUTS.GraphQLAPIEndpointOutput);
    const getApiKey = outputValueSelector(ResourceConstants.OUTPUTS.GraphQLAPIApiKeyOutput);
    GRAPHQL_ENDPOINT = getApiEndpoint(finishedStack.Outputs);

    const apiKey = getApiKey(finishedStack.Outputs);
    API_KEY = apiKey;
    expect(apiKey).toBeTruthy();

    const getIdentityPoolId = outputValueSelector('IdentityPoolId');
    const identityPoolId = getIdentityPoolId(finishedStack.Outputs);
    expect(identityPoolId).toBeTruthy();

    // Verify we have all the details
    expect(GRAPHQL_ENDPOINT).toBeTruthy();
    expect(USER_POOL_ID).toBeTruthy();
    expect(userPoolClientId).toBeTruthy();

    // Configure Amplify, create users, and sign in.
    configureAmplify(USER_POOL_ID, userPoolClientId, identityPoolId);

    await signupUser(USER_POOL_ID, USERNAME1, TMP_PASSWORD);
    await signupUser(USER_POOL_ID, USERNAME2, TMP_PASSWORD);
    await signupUser(USER_POOL_ID, USERNAME3, TMP_PASSWORD);
    await createGroup(USER_POOL_ID, INSTRUCTOR_GROUP_NAME);
    await createGroup(USER_POOL_ID, MEMBER_GROUP_NAME);
    await createGroup(USER_POOL_ID, ADMIN_GROUP_NAME);
    await addUserToGroup(ADMIN_GROUP_NAME, USERNAME1, USER_POOL_ID);
    await addUserToGroup(MEMBER_GROUP_NAME, USERNAME2, USER_POOL_ID);
    await addUserToGroup(INSTRUCTOR_GROUP_NAME, USERNAME1, USER_POOL_ID);
    await addUserToGroup(INSTRUCTOR_GROUP_NAME, USERNAME2, USER_POOL_ID);

    const authResAfterGroup: any = await authenticateUser(USERNAME1, TMP_PASSWORD, REAL_PASSWORD);
    const idToken = authResAfterGroup.getIdToken().getJwtToken();
    GRAPHQL_CLIENT_1 = new AWSAppSyncClient({
      url: GRAPHQL_ENDPOINT,
      region: AWS_REGION,
      disableOffline: true,
      offlineConfig: {
        keyPrefix: 'userPools',
      },
      auth: {
        type: AUTH_TYPE.AMAZON_COGNITO_USER_POOLS,
        jwtToken: idToken,
      },
    });

    const authRes2AfterGroup: any = await authenticateUser(USERNAME2, TMP_PASSWORD, REAL_PASSWORD);
    const idToken2 = authRes2AfterGroup.getIdToken().getJwtToken();
    GRAPHQL_CLIENT_2 = new AWSAppSyncClient({
      url: GRAPHQL_ENDPOINT,
      region: AWS_REGION,
      disableOffline: true,
      offlineConfig: {
        keyPrefix: 'userPools',
      },
      auth: {
        type: AUTH_TYPE.AMAZON_COGNITO_USER_POOLS,
        jwtToken: idToken2,
      },
    });

    const authRes3: any = await authenticateUser(USERNAME3, TMP_PASSWORD, REAL_PASSWORD);
    const idToken3 = authRes3.getIdToken().getJwtToken();
    GRAPHQL_CLIENT_3 = new AWSAppSyncClient({
      url: GRAPHQL_ENDPOINT,
      region: AWS_REGION,
      disableOffline: true,
      offlineConfig: {
        keyPrefix: 'userPools',
      },
      auth: {
        type: AUTH_TYPE.AMAZON_COGNITO_USER_POOLS,
        jwtToken: idToken3,
      },
    });

    await Auth.signIn(USERNAME1, REAL_PASSWORD);
    const authCredentials = await Auth.currentUserCredentials();
    GRAPHQL_IAM_AUTH_CLIENT = new AWSAppSyncClient({
      url: GRAPHQL_ENDPOINT,
      region: AWS_REGION,
      disableOffline: true,
      offlineConfig: {
        keyPrefix: 'iam',
      },
      auth: {
        type: AUTH_TYPE.AWS_IAM,
        credentials: Auth.essentialCredentials(authCredentials),
      },
    });

    GRAPHQL_APIKEY_CLIENT = new AWSAppSyncClient({
      url: GRAPHQL_ENDPOINT,
      region: AWS_REGION,
      disableOffline: true,
      offlineConfig: {
        keyPrefix: 'apikey',
      },
      auth: {
        type: AUTH_TYPE.API_KEY,
        apiKey,
      },
    });
    API.configure({
      aws_appsync_graphqlEndpoint: GRAPHQL_ENDPOINT,
      aws_appsync_region: AWS_REGION,
      aws_appsync_authenticationType: 'AMAZON_COGNITO_USER_POOLS',
    });

    // Wait for any propagation to avoid random
    // "The security token included in the request is invalid" errors
    await new Promise(res => setTimeout(res, PROPAGATION_DELAY));
  } catch (e) {
    console.log(e);

    expect(true).toEqual(false);
  }
});

afterAll(async () => {
  await cleanupStackAfterTest(BUCKET_NAME, STACK_NAME, cf, { cognitoClient, userPoolId: USER_POOL_ID });
});

/**
 * Tests
 */

// tests using cognito
test('Test that only authorized members are allowed to view subscriptions', async () => {
  // subscribe to create students as user 2
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnCreateStudent {
        onCreateStudent {
          id
          name
          email
          ssn
          owner
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, _) => {
    subscription = observer.subscribe((event: any) => {
      const student = event.value.data.onCreateStudent;
      subscription.unsubscribe();
      expect(student.name).toEqual('student1');
      expect(student.email).toEqual('student1@domain.com');
      expect(student.ssn).toBeNull();
      resolve(undefined);
    });
  });

  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  await createStudent(GRAPHQL_CLIENT_1, {
    name: 'student1',
    email: 'student1@domain.com',
    ssn: 'AAA-01-SSSS',
  });

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnCreateStudent Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('Test a subscription on update', async () => {
  // subscribe to update students as user 2
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME2, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnUpdateStudent {
        onUpdateStudent {
          id
          name
          email
          ssn
          owner
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, _) => {
    subscription = observer.subscribe((event: any) => {
      const student = event.value.data.onUpdateStudent;
      subscription.unsubscribe();
      expect(student.id).toEqual(student3ID);
      expect(student.name).toEqual('student3');
      expect(student.email).toEqual('emailChanged@domain.com');
      expect(student.ssn).toBeNull();
      resolve(undefined);
    });
  });
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  const student3 = await createStudent(GRAPHQL_CLIENT_1, {
    name: 'student3',
    email: 'changeThisEmail@domain.com',
    ssn: 'CCC-01-SNSN',
  });
  expect(student3.data.createStudent).toBeDefined();
  const student3ID = student3.data.createStudent.id;
  expect(student3.data.createStudent.name).toEqual('student3');
  expect(student3.data.createStudent.email).toEqual('changeThisEmail@domain.com');
  expect(student3.data.createStudent.ssn).toBeNull();

  await updateStudent(GRAPHQL_CLIENT_1, {
    id: student3ID,
    email: 'emailChanged@domain.com',
  });

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnUpdateStudent Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('Test a subscription on delete', async () => {
  // subscribe to onDelete as user 2
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME2, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnDeleteStudent {
        onDeleteStudent {
          id
          name
          email
          ssn
          owner
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, reject) => {
    subscription = observer.subscribe({
      next: event => {
        const student = event.value.data.onDeleteStudent;
        subscription.unsubscribe();
        expect(student.id).toEqual(student4ID);
        expect(student.name).toEqual('student4');
        expect(student.email).toEqual('plsDelete@domain.com');
        expect(student.ssn).toBeNull();
        resolve(undefined);
      },
      error: err => {
        reject(err);
      },
    });
  });
  const student4 = await createStudent(GRAPHQL_CLIENT_1, {
    name: 'student4',
    email: 'plsDelete@domain.com',
    ssn: 'DDD-02-SNSN',
  });
  expect(student4).toBeDefined();
  const student4ID = student4.data.createStudent.id;
  expect(student4.data.createStudent.email).toEqual('plsDelete@domain.com');
  expect(student4.data.createStudent.ssn).toBeNull();

  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  await deleteStudent(GRAPHQL_CLIENT_1, { id: student4ID });

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnDeleteStudent Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('test that group is only allowed to listen to subscriptions and listen to onCreate', async () => {
  const memberID = '001';
  const memberName = 'username00';
  // test that a user that only read can't mutate
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME2, REAL_PASSWORD);
  try {
    await createMember(GRAPHQL_CLIENT_2, { id: '001', name: 'notUser' });
  } catch (err) {
    expect(err).toBeDefined();
    expect(err.graphQLErrors[0].errorType).toEqual('Unauthorized');
  }

  // though they should see when a new member is created
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnCreateMember {
        onCreateMember {
          id
          name
          createdAt
          updatedAt
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, _) => {
    subscription = observer.subscribe((event: any) => {
      const member = event.value.data.onCreateMember;
      subscription.unsubscribe();
      expect(member).toBeDefined();
      expect(member.id).toEqual(memberID);
      expect(member.name).toEqual(memberName);
      resolve(undefined);
    });
  });
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));
  // user that is authorized creates the update the mutation
  const createMemberResponse = await createMember(GRAPHQL_CLIENT_1, { id: memberID, name: memberName });
  expect(createMemberResponse.data.createMember.id).toEqual(memberID);
  expect(createMemberResponse.data.createMember.name).toEqual(memberName);

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnCreateMember Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('authorized group is allowed to listen to onUpdate', async () => {
  const memberID = '001update';
  const oldMemberName = 'oldUsername';
  const newMemberName = 'newUsername';
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME2, REAL_PASSWORD);

  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnUpdateMember {
        onUpdateMember {
          id
          name
          createdAt
          updatedAt
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;

  const subscriptionPromise = new Promise((resolve, reject) => {
    subscription = observer.subscribe({
      next: event => {
        const subResponse = event.value.data.onUpdateMember;
        subscription.unsubscribe();
        expect(subResponse).toBeDefined();
        expect(subResponse.id).toEqual(memberID);
        expect(subResponse.name).toEqual(newMemberName);
        resolve(undefined);
      },
      complete: () => {},
      error: err => {
        reject(err);
      },
    });
  });
  const createMemberResponse = await createMember(GRAPHQL_CLIENT_1, { id: memberID, name: oldMemberName });
  expect(createMemberResponse.data.createMember.id).toEqual(memberID);
  expect(createMemberResponse.data.createMember.name).toEqual(oldMemberName);
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));
  // user that is authorized creates the update the mutation
  const updateMemberResponse = await updateMember(GRAPHQL_CLIENT_1, { id: memberID, name: newMemberName });
  expect(updateMemberResponse.data.updateMember.id).toEqual(memberID);
  expect(updateMemberResponse.data.updateMember.name).toEqual(newMemberName);

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnUpdateMember Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('authorized group is allowed to listen to onDelete', async () => {
  const memberID = '001delete';
  const memberName = 'newUsername';
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME2, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnDeleteMember {
        onDeleteMember {
          id
          name
          createdAt
          updatedAt
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;

  const subscriptionPromise = new Promise((resolve, reject) => {
    subscription = observer.subscribe({
      next: event => {
        subscription.unsubscribe();
        const subResponse = event.value.data.onDeleteMember;
        subscription.unsubscribe();
        expect(subResponse).toBeDefined();
        expect(subResponse.id).toEqual(memberID);
        expect(subResponse.name).toEqual(memberName);
        resolve(undefined);
      },
      error: err => {
        reject(err);
      },
    });
  });

  const createMemberResponse = await createMember(GRAPHQL_CLIENT_1, { id: memberID, name: memberName });
  expect(createMemberResponse.data.createMember.id).toEqual(memberID);
  expect(createMemberResponse.data.createMember.name).toEqual(memberName);
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));
  // user that is authorized creates the update the mutation
  const deleteMemberResponse = await deleteMember(GRAPHQL_CLIENT_1, { id: memberID });
  expect(deleteMemberResponse.data.deleteMember.id).toEqual(memberID);

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnDeleteMember Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

// ownerField Tests
test('Test subscription onCreatePost with ownerField', async () => {
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
    subscription OnCreatePost {
        onCreatePost(postOwner: "${USERNAME1}") {
            id
            title
            postOwner
        }
    }`,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, _) => {
    subscription = observer.subscribe((event: any) => {
      const post = event.value.data.onCreatePost;
      subscription.unsubscribe();
      expect(post.title).toEqual('someTitle');
      expect(post.postOwner).toEqual(USERNAME1);
      resolve(undefined);
    });
  });
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  const createPostResponse = await createPost(GRAPHQL_CLIENT_1, {
    title: 'someTitle',
    postOwner: USERNAME1,
  });
  expect(createPostResponse.data.createPost.title).toEqual('someTitle');
  expect(createPostResponse.data.createPost.postOwner).toEqual(USERNAME1);

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnCreatePost Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('Test onCreatePost with incorrect owner argument should throw an error', async () => {
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const failedObserver = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnCreatePost {
        onCreatePost(postOwner: "${USERNAME2}") {
          id
          title
          postOwner
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, reject) => {
    subscription = failedObserver.subscribe(
      event => {
        subscription.unsubscribe();
        reject("Should throw unauthorized error.");
      },
      err => {
        expect(err.error.errors[0].message).toEqual(
          'Connection failed: {"errors":[{"errorType":"Unauthorized","message":"Not Authorized to access onCreatePost on type Subscription"}]}',
        );
        resolve(undefined);
      },
    );
  });

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnCreatePost Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

// iam tests
test('Test that IAM can listen and read to onCreatePost', async () => {
  const postID = 'subscriptionID';
  const postTitle = 'titleMadeByPostOwner';

  reconfigureAmplifyAPI('AWS_IAM');
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnCreatePost {
        onCreatePost {
          id
          title
          postOwner
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.AWS_IAM,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;

  const subscriptionPromise = new Promise((resolve, reject) => {
    subscription = observer.subscribe(
      (event: any) => {
        const post = event.value.data.onCreatePost;
        subscription.unsubscribe();
        expect(post).toBeDefined();
        expect(post.id).toEqual(postID);
        expect(post.title).toEqual(postTitle);
        expect(post.postOwner).toEqual(USERNAME1);
        resolve(undefined);
      },
      err => {
        reject(err);
      },
    );
  });
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  const createPostResponse = await createPost(GRAPHQL_CLIENT_1, { id: postID, title: postTitle, postOwner: USERNAME1 });
  expect(createPostResponse.data.createPost.id).toEqual(postID);
  expect(createPostResponse.data.createPost.title).toEqual(postTitle);
  expect(createPostResponse.data.createPost.postOwner).toEqual(USERNAME1);
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));
  await subscriptionPromise;
});

test('test that subcsription with apiKey', async () => {
  reconfigureAmplifyAPI('API_KEY', API_KEY);
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnCreateTodo {
        onCreateTodo {
          id
          description
          name
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.API_KEY,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;

  const subscriptionPromise = new Promise((resolve, _) => {
    subscription = observer.subscribe((event: any) => {
      const post = event.value.data.onCreateTodo;
      subscription.unsubscribe();
      expect(post.description).toEqual('someDescription');
      expect(post.name).toBeNull();
      resolve(undefined);
    });
  });

  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  const createTodoResponse = await createTodo(GRAPHQL_IAM_AUTH_CLIENT, {
    description: 'someDescription',
    name: 'todo1',
  });
  expect(createTodoResponse.data.createTodo.description).toEqual('someDescription');
  expect(createTodoResponse.data.createTodo.name).toEqual(null);

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnCreateTodo Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('test that subscription with apiKey onUpdate', async () => {
  reconfigureAmplifyAPI('API_KEY', API_KEY);
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnUpdateTodo {
        onUpdateTodo {
          id
          description
          name
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.API_KEY,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, reject) => {
    subscription = observer.subscribe(
      (event: any) => {
        const todo = event.value.data.onUpdateTodo;
        subscription.unsubscribe();
        expect(todo.id).toEqual(todo2ID);
        expect(todo.description).toEqual('todo2newDesc');
        expect(todo.name).toBeNull();
        resolve(undefined);
      },
      err => {
        reject(undefined);
      },
    );
  });
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  const todo2 = await createTodo(GRAPHQL_IAM_AUTH_CLIENT, {
    description: 'updateTodoDesc',
    name: 'todo2',
  });
  expect(todo2.data.createTodo.id).toBeDefined();
  const todo2ID = todo2.data.createTodo.id;
  expect(todo2.data.createTodo.description).toEqual('updateTodoDesc');
  expect(todo2.data.createTodo.name).toBeNull();

  // update the description on todo
  const updateResponse = await updateTodo(GRAPHQL_IAM_AUTH_CLIENT, {
    id: todo2ID,
    description: 'todo2newDesc',
  });
  expect(updateResponse.data.updateTodo.id).toEqual(todo2ID);
  expect(updateResponse.data.updateTodo.description).toEqual('todo2newDesc');

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'createTodo Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('test that subscription with apiKey onDelete', async () => {
  reconfigureAmplifyAPI('API_KEY', API_KEY);
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnDeleteTodo {
        onDeleteTodo {
          id
          description
          name
        }
      }
    `,
    authMode: GRAPHQL_AUTH_MODE.API_KEY,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, _) => {
    subscription = observer.subscribe((event: any) => {
      const todo = event.value.data.onDeleteTodo;
      subscription.unsubscribe();
      expect(todo.id).toEqual(todo3ID);
      expect(todo.description).toEqual('deleteTodoDesc');
      expect(todo.name).toBeNull();
      resolve(undefined);
    });
  });
  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  const todo3 = await createTodo(GRAPHQL_IAM_AUTH_CLIENT, {
    description: 'deleteTodoDesc',
    name: 'todo3',
  });
  expect(todo3.data.createTodo.id).toBeDefined();
  const todo3ID = todo3.data.createTodo.id;
  expect(todo3.data.createTodo.description).toEqual('deleteTodoDesc');
  expect(todo3.data.createTodo.name).toBeNull();

  // delete todo3
  await deleteTodo(GRAPHQL_IAM_AUTH_CLIENT, {
    id: todo3ID,
  });

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, ' OnDelete Todo Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

test('Test subscriptions with variable syntax', async () => {
  reconfigureAmplifyAPI('AMAZON_COGNITO_USER_POOLS');
  await Auth.signIn(USERNAME1, REAL_PASSWORD);
  const observer = API.graphql({
    // @ts-ignore
    query: gql`
      subscription OnCreateStudent($owner: String) {
        onCreateStudent(owner: $owner) {
          id
          name
          email
          ssn
          owner
        }
      }
    `,
    variables: {
      owner: USERNAME1,
    },
    authMode: GRAPHQL_AUTH_MODE.AMAZON_COGNITO_USER_POOLS,
  }) as unknown as Observable<any>;
  let subscription: ZenObservable.Subscription;
  const subscriptionPromise = new Promise((resolve, _) => {
    subscription = observer.subscribe((event: any) => {
      const student = event.value.data.onCreateStudent;
      subscription.unsubscribe();
      expect(student.name).toEqual('student_variable_1');
      expect(student.email).toEqual('student1@domain.com');
      expect(student.ssn).toBeNull();
      resolve(undefined);
    });
  });

  await new Promise(res => setTimeout(res, SUBSCRIPTION_DELAY));

  await createStudent(GRAPHQL_CLIENT_1, {
    name: 'student_variable_1',
    email: 'student1@domain.com',
    ssn: 'AAA-01-SSSS',
  });

  return withTimeOut(subscriptionPromise, SUBSCRIPTION_TIMEOUT, 'OnCreateStudent Subscription timed out', () => {
    subscription?.unsubscribe();
  });
});

function reconfigureAmplifyAPI(appSyncAuthType: string, apiKey?: string) {
  if (appSyncAuthType === 'API_KEY') {
    API.configure({
      aws_appsync_graphqlEndpoint: GRAPHQL_ENDPOINT,
      aws_appsync_region: AWS_REGION,
      aws_appsync_authenticationType: appSyncAuthType,
      aws_appsync_apiKey: apiKey,
    });
  } else {
    API.configure({
      aws_appsync_graphqlEndpoint: GRAPHQL_ENDPOINT,
      aws_appsync_region: AWS_REGION,
      aws_appsync_authenticationType: appSyncAuthType,
    });
  }
}

// mutations
async function createMember(client: AWSAppSyncClient<any>, input: MemberInput) {
  const request = gql`
    mutation CreateMember($input: CreateMemberInput!) {
      createMember(input: $input) {
        id
        name
        createdAt
        updatedAt
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function updateMember(client: AWSAppSyncClient<any>, input: MemberInput) {
  const request = gql`
    mutation UpdateMember($input: UpdateMemberInput!) {
      updateMember(input: $input) {
        id
        name
        createdAt
        updatedAt
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function deleteMember(client: AWSAppSyncClient<any>, input: MemberInput) {
  const request = gql`
    mutation DeleteMember($input: DeleteMemberInput!) {
      deleteMember(input: $input) {
        id
        name
        createdAt
        updatedAt
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function createStudent(client: AWSAppSyncClient<any>, input: CreateStudentInput) {
  const request = gql`
    mutation CreateStudent($input: CreateStudentInput!) {
      createStudent(input: $input) {
        id
        name
        email
        ssn
        owner
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function updateStudent(client: AWSAppSyncClient<any>, input: UpdateStudentInput) {
  const request = gql`
    mutation UpdateStudent($input: UpdateStudentInput!) {
      updateStudent(input: $input) {
        id
        name
        email
        ssn
        owner
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function deleteStudent(client: AWSAppSyncClient<any>, input: DeleteTypeInput) {
  const request = gql`
    mutation DeleteStudent($input: DeleteStudentInput!) {
      deleteStudent(input: $input) {
        id
        name
        email
        ssn
        owner
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function createPost(client: AWSAppSyncClient<any>, input: CreatePostInput) {
  const request = gql`
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        id
        title
        postOwner
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function createTodo(client: AWSAppSyncClient<any>, input: CreateTodoInput) {
  const request = gql`
    mutation CreateTodo($input: CreateTodoInput!) {
      createTodo(input: $input) {
        id
        description
        name
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function updateTodo(client: AWSAppSyncClient<any>, input: UpdateTodoInput) {
  const request = gql`
    mutation UpdateTodo($input: UpdateTodoInput!) {
      updateTodo(input: $input) {
        id
        description
        name
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}

async function deleteTodo(client: AWSAppSyncClient<any>, input: DeleteTypeInput) {
  const request = gql`
    mutation DeleteTodo($input: DeleteTodoInput!) {
      deleteTodo(input: $input) {
        id
        description
        name
      }
    }
  `;
  return await client.mutate<any>({ mutation: request, variables: { input } });
}
