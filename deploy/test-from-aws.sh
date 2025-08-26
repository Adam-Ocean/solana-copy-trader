#!/bin/bash

# Test speed from multiple AWS regions simultaneously
# This creates micro EC2 instances, runs the test, and terminates them

REGIONS=("us-east-1" "us-west-2" "eu-west-1" "ap-southeast-1")
AMI_ID="ami-0c02fb55731490381" # Amazon Linux 2
INSTANCE_TYPE="t3.micro"
KEY_NAME="your-key-name" # Change this to your key pair name

echo "🚀 Launching speed tests from multiple AWS regions..."

for region in "${REGIONS[@]}"; do
    echo "📍 Testing from $region..."
    
    # Launch instance and run test
    aws ec2 run-instances \
        --region "$region" \
        --image-id "$AMI_ID" \
        --instance-type "$INSTANCE_TYPE" \
        --key-name "$KEY_NAME" \
        --instance-initiated-shutdown-behavior terminate \
        --user-data "#!/bin/bash
            # Install Node.js
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo yum install -y nodejs
            
            # Download and run speed test
            curl -o speed-test.js https://raw.githubusercontent.com/your-repo/copy-trader/main/speed-test.js
            
            # Run test and save results
            echo '===== Speed Test from $region =====' > /tmp/result.txt
            node speed-test.js >> /tmp/result.txt
            
            # Upload results to S3 (optional)
            # aws s3 cp /tmp/result.txt s3://your-bucket/speed-test-$region.txt
            
            # Print results
            cat /tmp/result.txt
            
            # Self-terminate after test
            sudo shutdown -h now
        " \
        --output text \
        --query 'Instances[0].InstanceId'
done

echo "✅ Tests launched in all regions. Check AWS console for results."