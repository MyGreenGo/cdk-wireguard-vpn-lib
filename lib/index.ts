// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface CdkWireguardLibProps {
  // Define construct properties here
}

export class CdkWireguardLib extends Construct {

  constructor(scope: Construct, id: string, props: CdkWireguardLibProps = {}) {
    super(scope, id);

    // Define construct contents here

    // example resource
    // const queue = new sqs.Queue(this, 'CdkWireguardLibQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
