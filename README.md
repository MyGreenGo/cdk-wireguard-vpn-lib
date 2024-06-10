# Welcome to your CDK TypeScript Construct Library project

You should explore the contents of this project. It demonstrates a CDK Construct Library that includes a construct (`CdkWireguardLib`)
which contains an ECS Cluster with an autoscaling group, trying to keep 1 instance of the wireguard VPN up.

The construct defines an interface (`CdkWireguardLibProps`) to configure the visibility timeout of the queue.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests

## What

A CDK library to develop a Wireguard VPN, to use for example, as a Bastion.

### Components: 

* ECS Cluster with EC2 autoscaling group
* EC2 instance is a T4G.nano instance
* En elastic IP for the VPN
* A NFS to store permanently VPN accesses


* Cheap: ~$10/m
    * EC2.T4g.nano: $4/m
    * NFS: $0.33/m
    * EIP: $5/m
    * SecretManager: $0.40/m

* Self healing with Autoscaling group 


## Inspirations: 

* https://github.com/rajyan/low-cost-ecs

## Todo

* [ ] Improve release management
* [ ] Improve readme
* [ ] Add SSL support to UI