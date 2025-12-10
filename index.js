const express = require('express')
const cors = require('cors')
const app = express()
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const port = process.env.PORT || 3000

const admin = require("firebase-admin");

// Convert hex string from .env to JSON object
const serviceAccountHex = process.env.FIREBASE_SERVICE_ACCOUNT_HEX;
if (!serviceAccountHex) {
  console.error('FIREBASE_SERVICE_ACCOUNT_HEX not found in .env file');
  process.exit(1);
}

const serviceAccountJson = Buffer.from(serviceAccountHex, 'hex').toString('utf8');
const serviceAccount = JSON.parse(serviceAccountJson);

admin.initializeApp({
   credential: admin.credential.cert(serviceAccount)
});

// middleware

app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
   const token = req.headers.authorization;

   if (!token) {
      return res.status(401).send({ message: 'unauthorized access' })
   }

   // Check if token has Bearer prefix
   if (!token.startsWith('Bearer ')) {
      return res.status(401).send({ message: 'unauthorized access' })
   }

   try {
      const idToken = token.split(' ')[1];
      const decoded = await admin.auth().verifyIdToken(idToken)
      console.log('decoded in the token', decoded)
      req.decoded_email = decoded.email
      req.decoded = decoded; // Store full decoded token for access to other properties

      next()
   }
   catch (err) {
      console.error('Token verification error:', err);
      return res.status(401).send({ message: 'unauthorized access' })
   }
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ggbd.znymale.mongodb.net/?appName=ggbd`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
   serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
   }
});

async function run() {
   try {
      // Connect the client to the server
      await client.connect();
      console.log("Connected to MongoDB successfully!");

      const db = client.db('finlix_db');
      const loansCollection = db.collection('loans');
      const usersCollection = db.collection('users');
      
      // Middleware to verify if user is admin (moved inside run() function)
      const verifyAdmin = async (req, res, next) => {
         const email = req.decoded.email;
         
         try {
            // Find user in database
            const user = await usersCollection.findOne({ email: email });
            
            if (!user) {
               return res.status(403).send({ message: 'Forbidden: User not found' });
            }
            
            if (user.role !== 'admin') {
               return res.status(403).send({ message: 'Forbidden: Admin access required' });
            }
            
            next();
         } catch (error) {
            console.error('Admin verification error:', error);
            return res.status(500).send({ message: 'Internal server error' });
         }
      }

      // Middleware to verify if user is manager
      const verifyManager = async (req, res, next) => {
         const email = req.decoded.email;
         
         try {
            
            const user = await usersCollection.findOne({ email: email });
            
            if (!user) {
               return res.status(403).send({ message: 'Forbidden: User not found' });
            }
            
            if (user.role !== 'manager') {
               return res.status(403).send({ message: 'Forbidden: Manager access required' });
            }
            
            next();
         } catch (error) {
            console.error('Manager verification error:', error);
            return res.status(500).send({ message: 'Internal server error' });
         }
      }

      // user related apis
      app.post('/users',   async (req, res) => {
         const user = req.body;
         console.log('Received user data:', user); 

         // Validate required fields
         if (!user.email) {
            return res.status(400).send({ message: 'Email is required' });
         }

         user.role = user.role || 'borrower';
         user.status = 'pending';
         user.createdAt = new Date();

         const email = user.email;
         console.log('Processing user with email:', email);

         const userExists = await usersCollection.findOne({ email });

         if (userExists) {
            console.log('User exists, updating...'); 
            console.log('Updating with data:', {
               name: user.name,
               photoURL: user.photoURL,
               role: user.role,
               status: user.status,
               createdAt: user.createdAt
            });

            // Update existing user with new information
            const updatedUser = {
               $set: {
                  name: user.name,
                  photoURL: user.photoURL,
                  role: user.role,
                  status: user.status,
                  createdAt: user.createdAt
               }
            };

            const result = await usersCollection.updateOne({ email }, updatedUser);
            console.log('Update result:', result); 
            return res.send(result);
         }

         console.log('Creating new user with data:', user); 
         const result = await usersCollection.insertOne(user);
         console.log('Insert result:', result);
         res.send(result);
      })

      app.get('/users/:id', async (req, res) => {

      })
      app.get('/users/:email/role', async (req, res) => {
         const email = req.params.email;
         const query = { email: email };  
         const user = await usersCollection.findOne(query);
         res.send({ role: user?.role || 'user' });
      })

      // Profile API - Get user profile (secure)
      app.get('/profile', verifyFBToken, async (req, res) => {
         try {
            const email = req.decoded.email;
            console.log('Profile request for email:', email);

            // Find user in database
            const user = await usersCollection.findOne({ email: email });
            console.log('Found user:', user);

            if (!user) {
               // If user doesn't exist in DB, return an error
               // Users should be created during registration, not here
               console.log('User not found in database');
               return res.status(404).json({ error: 'User profile not found' });
            }

            res.json(user);
         } catch (error) {
            console.error('Error fetching user profile:', error);
            res.status(500).json({ error: 'Failed to fetch profile' });
         }
      });

      // Profile API - Update user profile (secure)
      app.put('/profile', verifyFBToken, async (req, res) => {
         try {
            const email = req.decoded.email;
            const updatedData = req.body;

            // Only allow updating name and photoURL
            const updateFields = {
               name: updatedData.name,
               photoURL: updatedData.photoURL
            };

            const result = await usersCollection.updateOne(
               { email: email },
               { $set: updateFields }
            );

            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'User not found' });
            }

            res.json({ message: 'Profile updated successfully' });
         } catch (error) {
            console.error('Error updating user profile:', error);
            res.status(500).json({ error: 'Failed to update profile' });
         }
      });

      // Get all users (for admin panel)
      app.get('/users', verifyFBToken, verifyAdmin, async (req, res) => {
         try {
            const users = await usersCollection.find({}).toArray();
            res.json(users);
         } catch (error) {
            console.error('Error fetching users:', error);
            res.status(500).json({ error: 'Failed to fetch users' });
         }
      });

      // Update user role (for admin panel)
      app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
         try {
            const { id } = req.params;
            const { role } = req.body;
            
            // Validate role
            if (!['borrower', 'manager', 'admin'].includes(role)) {
               return res.status(400).json({ error: 'Invalid role' });
            }
            
            const result = await usersCollection.updateOne(
               { _id: new ObjectId(id) },
               { $set: { role: role } }
            );
            
            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'User not found' });
            }
            
            res.json({ message: 'User role updated successfully' });
         } catch (error) {
            console.error('Error updating user role:', error);
            res.status(500).json({ error: 'Failed to update user role' });
         }
      });

      // Suspend user
      app.patch('/users/:id/suspend', verifyFBToken, verifyAdmin, async (req, res) => {
         try {
            const { id } = req.params;
            
            const result = await usersCollection.updateOne(
               { _id: new ObjectId(id) },
               { $set: { status: 'suspended' } }
            );
            
            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'User not found' });
            }
            
            res.json({ message: 'User suspended successfully' });
         } catch (error) {
            console.error('Error suspending user:', error);
            res.status(500).json({ error: 'Failed to suspend user' });
         }
      });

      // Approve user
      app.patch('/users/:id/approve', verifyFBToken, async (req, res) => {
         try {
            const { id } = req.params;
            
            const result = await usersCollection.updateOne(
               { _id: new ObjectId(id) },
               { $set: { status: 'approved' } }
            );
            
            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'User not found' });
            }
            
            res.json({ message: 'User approved successfully' });
         } catch (error) {
            console.error('Error approving user:', error);
            res.status(500).json({ error: 'Failed to approve user' });
         }
      });

      // loan api
      app.get('/loans', verifyFBToken, async (req, res) => {
         try {
            const query = {};
            const { email } = req.query;

            // Security check: Only allow users to query their own loans
            // If email is provided in query, it must match the authenticated user's email
            if (email && email !== req.decoded.email) {
               return res.status(403).json({ error: 'Forbidden: Cannot access other users\' loan data' });
            }

            // If no email is provided, default to the authenticated user's email
            if (!email) {
               query.email = req.decoded.email;
            } else {
               query.email = email;
            }

            const options = { sort: { createdAt: -1 } }

            const loans = await loansCollection.find(query, options).toArray();
            res.json(loans);
         } catch (error) {
            console.error('Error fetching loans:', error);
            res.status(500).json({ error: 'Failed to fetch loans' });
         }
      })

      app.post('/loans', verifyFBToken, async (req, res) => {
         try {
            const loan = req.body;
            // Add timestamp for when the loan application was created
            loan.createdAt = new Date();
            // Ensure the email is set to the authenticated user's email for security
            loan.email = req.decoded.email;
            console.log('Received loan application:', loan);
            const result = await loansCollection.insertOne(loan);
            console.log('Loan application saved:', result);
            res.send(result);
         } catch (error) {
            console.error('Error saving loan application:', error);
            res.status(500).json({ error: 'Failed to save loan application' });
         }
      })

      // PATCH endpoint to update loan status (for cancellation)
      app.patch('/loans/:id', verifyFBToken, async (req, res) => {
         try {
            const { id } = req.params;
            const { status } = req.body;

            // Security check: Only allow users to update their own loans
            // First, find the loan to verify ownership
            const loan = await loansCollection.findOne({ _id: new ObjectId(id) });

            if (!loan) {
               return res.status(404).json({ error: 'Loan not found' });
            }

            // Check if the loan belongs to the authenticated user
            if (loan.email !== req.decoded.email) {
               return res.status(403).json({ error: 'Forbidden: Cannot modify other users\' loan data' });
            }

            // Only allow updating status if current status is 'Pending'
            const filter = { _id: new ObjectId(id), status: 'Pending' };
            const updateDoc = { $set: { status: status } };

            const result = await loansCollection.updateOne(filter, updateDoc);

            if (result.matchedCount === 0) {
               return res.status(400).json({ error: 'Loan not found or not in Pending status' });
            }

            res.json({ message: 'Loan status updated successfully', result });
         } catch (error) {
            console.error('Error updating loan status:', error);
            res.status(500).json({ error: 'Failed to update loan status' });
         }
      })

      // DELETE endpoint to delete loan (alternative approach)
      app.delete('/loans/:id', verifyFBToken, async (req, res) => {
         try {
            const { id } = req.params;

            // Security check: Only allow users to delete their own loans
            // First, find the loan to verify ownership
            const loan = await loansCollection.findOne({ _id: new ObjectId(id) });

            if (!loan) {
               return res.status(404).json({ error: 'Loan not found' });
            }

            // Check if the loan belongs to the authenticated user
            if (loan.email !== req.decoded.email) {
               return res.status(403).json({ error: 'Forbidden: Cannot delete other users\' loan data' });
            }

            // Only allow deletion if current status is 'Pending'
            const filter = { _id: new ObjectId(id), status: 'Pending' };

            const result = await loansCollection.deleteOne(filter);

            if (result.deletedCount === 0) {
               return res.status(400).json({ error: 'Loan not found or not in Pending status' });
            }

            res.json({ message: 'Loan deleted successfully', result });
         } catch (error) {
            console.error('Error deleting loan:', error);
            res.status(500).json({ error: 'Failed to delete loan' });
         }
      })

      // Get loans by user email
      app.get('/loans/user/:email', verifyFBToken, async (req, res) => {
         try {
            const email = req.params.email;
            const loans = await loansCollection.find({ email: email }).sort({ createdAt: -1 }).toArray();
            res.json(loans);
         } catch (error) {
            console.error('Error fetching user loans:', error);
            res.status(500).json({ error: 'Failed to fetch loans' });
         }
      });


      // Admin - Get all loans
      app.get('/loans/admin', verifyFBToken, async (req, res) => {
         try {
            // In a real application, you would check if the user is an admin
            // For now, we'll return all loans
            const loans = await loansCollection.find({}).sort({ createdAt: -1 }).toArray();
            res.json(loans);
         } catch (error) {
            console.error('Error fetching all loans:', error);
            res.status(500).json({ error: 'Failed to fetch loans' });
         }
      });

      // Admin - Get loan applications
      app.get('/loans/applications', verifyFBToken, async (req, res) => {
         try {
            // In a real application, you would check if the user is an admin
            // For now, we'll return all loans with status 'Pending' or 'Reviewing'
            const loans = await loansCollection.find({
               status: { $in: ['Pending', 'Reviewing'] }
            }).sort({ createdAt: -1 }).toArray();
            res.json(loans);
         } catch (error) {
            console.error('Error fetching loan applications:', error);
            res.status(500).json({ error: 'Failed to fetch loan applications' });
         }
      });

      // Admin - Update loan status
      app.patch('/loans/:id/status/admin', verifyFBToken, verifyAdmin, async (req, res) => {
         try {
            const { id } = req.params;
            const { status } = req.body;

            // Validate status
            if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
               return res.status(400).json({ error: 'Invalid status' });
            }

            const result = await loansCollection.updateOne(
               { _id: new ObjectId(id) },
               { $set: { status: status } }
            );

            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'Loan not found' });
            }

            res.json({ message: 'Loan status updated successfully', result });
         } catch (error) {
            console.error('Error updating loan status:', error);
            res.status(500).json({ error: 'Failed to update loan status' });
         }
      });

      // Admin - Toggle show on home
      app.patch('/loans/:id/show-on-home', verifyFBToken, async (req, res) => {
         try {
            const { id } = req.params;
            const { showOnHome } = req.body;

            const result = await loansCollection.updateOne(
               { _id: new ObjectId(id) },
               { $set: { showOnHome: showOnHome } }
            );

            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'Loan not found' });
            }

            res.json({ message: 'Loan show on home updated successfully', result });
         } catch (error) {
            console.error('Error updating loan show on home:', error);
            res.status(500).json({ error: 'Failed to update loan show on home' });
         }
      });

      // Admin - Delete loan
      app.delete('/loans/:id/admin', verifyFBToken, async (req, res) => {
         try {
            const { id } = req.params;

            // In a real application, you would check if the user is an admin
            // For now, we'll allow deletion of any loan
            const result = await loansCollection.deleteOne({ _id: new ObjectId(id) });

            if (result.deletedCount === 0) {
               return res.status(404).json({ error: 'Loan not found' });
            }

            res.json({ message: 'Loan deleted successfully', result });
         } catch (error) {
            console.error('Error deleting loan:', error);
            res.status(500).json({ error: 'Failed to delete loan' });
         }
      });

      // Manager - Update loan
      app.put('/loans/:id', verifyFBToken, verifyManager, async (req, res) => {
         try {
            const { id } = req.params;
            const updatedLoanData = req.body;

            // Remove fields that shouldn't be updated
            delete updatedLoanData._id;
            delete updatedLoanData.createdAt;
            delete updatedLoanData.createdBy;

            // Update the loan
            const result = await loansCollection.updateOne(
               { _id: new ObjectId(id) },
               { $set: updatedLoanData }
            );

            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'Loan not found' });
            }

            res.json({ message: 'Loan updated successfully', result });
         } catch (error) {
            console.error('Error updating loan:', error);
            res.status(500).json({ error: 'Failed to update loan' });
         }
      });

      // Manager - Add loan
      app.post('/loans', verifyFBToken, verifyManager, async (req, res) => {
         try {
            const loan = req.body;
            // Add timestamp for when the loan was created
            loan.createdAt = new Date();
            // Set created by from authenticated user
            loan.createdBy = req.decoded.email;
            // Default show on home to false
            loan.showOnHome = loan.showOnHome || false;

            const result = await loansCollection.insertOne(loan);
            res.json({ message: 'Loan created successfully', result });
         } catch (error) {
            console.error('Error creating loan:', error);
            res.status(500).json({ error: 'Failed to create loan' });
         }
      });

      // Manager - Get all loans (modified to show all loans, not just manager-created ones)
      app.get('/loans/manager', verifyFBToken, verifyManager, async (req, res) => {
         try {
            // Get all loans sorted by creation date
            const loans = await loansCollection.find({}).sort({ createdAt: -1 }).toArray();
            res.json(loans);
         } catch (error) {
            console.error('Error fetching manager loans:', error);
            res.status(500).json({ error: 'Failed to fetch loans' });
         }
      });

      // Manager - Get pending loans
      app.get('/loans/pending', verifyFBToken, verifyManager, async (req, res) => {
         try {
            const loans = await loansCollection.find({ status: 'Pending' }).sort({ createdAt: -1 }).toArray();
            res.json(loans);
         } catch (error) {
            console.error('Error fetching pending loans:', error);
            res.status(500).json({ error: 'Failed to fetch loans' });
         }
      });

      // Manager - Get approved loans
      app.get('/loans/approved', verifyFBToken, verifyManager, async (req, res) => {
         try {
            const loans = await loansCollection.find({ status: 'Approved' }).sort({ createdAt: -1 }).toArray();
            res.json(loans);
         } catch (error) {
            console.error('Error fetching approved loans:', error);
            res.status(500).json({ error: 'Failed to fetch loans' });
         }
      });

      // Manager - Get user statistics
      app.get('/users/manager-stats', verifyFBToken, verifyManager, async (req, res) => {
         try {
            const users = await usersCollection.find({}).toArray();
            
            const borrowerCount = users.filter(u => u.role === 'borrower').length;
            const managerCount = users.filter(u => u.role === 'manager').length;
            const adminCount = users.filter(u => u.role === 'admin').length;
            
            res.json({
               totalUsers: users.length,
               borrowerCount,
               managerCount,
               adminCount
            });
         } catch (error) {
            console.error('Error fetching user stats:', error);
            res.status(500).json({ error: 'Failed to fetch user stats' });
         }
      });

      // Manager - Update loan status
      app.patch('/loans/:id/status', verifyFBToken, verifyManager, async (req, res) => {
         try {
            const { id } = req.params;
            const { status } = req.body;

            // Validate status
            if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
               return res.status(400).json({ error: 'Invalid status' });
            }

            const result = await loansCollection.updateOne(
               { _id: new ObjectId(id) },
               { $set: { status: status } }
            );

            if (result.matchedCount === 0) {
               return res.status(404).json({ error: 'Loan not found' });
            }

            res.json({ message: 'Loan status updated successfully', result });
         } catch (error) {
            console.error('Error updating loan status:', error);
            res.status(500).json({ error: 'Failed to update loan status' });
         }
      });

      // Send a ping to confirm a successful connection
      await client.db("admin").command({ ping: 1 });
      console.log("Pinged your deployment. You successfully connected to MongoDB!");
   } catch (error) {
      console.error("MongoDB connection error:", error);
      process.exit(1); // Exit if we can't connect to MongoDB
   }
}
run().catch(console.dir);

app.get('/', (req, res) => {
   res.send('finlix is ok')
})

app.listen(port, () => {
   console.log(`Example app listening on port ${port}`)
})